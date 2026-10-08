-- =============================================================================
-- AI Assistance — CS Missed-Lead Tracker
-- =============================================================================
-- Defect / gap this fixes:
--   The CS desk is unmanned after hours, on breaks and between shifts. During
--   those gaps customers call CS Quo numbers and nobody answers, or they text
--   and get no reply, and new leads are lost because there is no single place
--   showing what was missed when the next shift starts.
--
--   This migration adds the backend for the "AI Assistance" section: it derives
--   the missed-follow-up list live from the existing Quo mirror
--   (quo_conversations + quo_messages) and lets the CS team claim an item as
--   handled. No lead row is ever touched.
--
-- What counts as a missed follow-up (verified against live data 2026-10):
--   * unanswered_text — the customer's most recent inbound contact is a TEXT and
--     no agent message came after it.
--   * missed_call — the customer's most recent inbound contact is a call that was
--     NOT answered (quo_messages.status = 'no-answer' on the ':call.completed'
--     row) and no agent response came after it.
--   Answered inbound calls (status 'completed'/'in-progress') are deliberately
--   NOT flagged — the call connected and was most likely handled on the phone,
--   so flagging it would be a false positive.
--   is_new_lead = the conversation has never had an agent message at all.
--
--   The derived call-event rows (':call.transcript.completed',
--   ':call.summary.completed', ':call.recording.completed') are excluded when
--   picking the latest inbound contact, so a transcript that lands after a call
--   can never mask the real missed call.
--
-- Auto-clear + manual claim:
--   An item clears automatically the moment an agent replies
--   (last_agent_message_at advances past last_customer_message_at). A CS member
--   can also mark it handled; "handled" is stored on quo_conversation_flags and
--   is relative to the last customer contact — if the customer messages again
--   after being handled, the item reappears.
--
-- Access: admin, cs_admin and customer_service (the CS team shares this
--   worklist, mirroring Quote Approval). The gate is enforced INSIDE each
--   function; the grant to `authenticated` is only a coarse gate. Writes go
--   through mark_cs_followup_handled (SECURITY DEFINER) rather than a direct
--   table update, because the quo_conversation_flags RLS does not include
--   cs_admin.
--
-- Tech lines (…7475887812) are excluded, matching isTechLineNumber() in the UI.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--   CREATE OR REPLACE FUNCTION.
--
-- ----------------------------------------------------------------------------
-- ROLLBACK
-- ----------------------------------------------------------------------------
--   DROP FUNCTION IF EXISTS public.mark_cs_followup_handled(uuid, boolean);
--   DROP FUNCTION IF EXISTS public.get_cs_missed_followup_count(timestamptz, timestamptz, uuid[]);
--   DROP FUNCTION IF EXISTS public.list_cs_missed_followups(timestamptz, timestamptz, uuid[]);
--   DROP INDEX  IF EXISTS public.idx_quo_conversations_last_customer_message_at;
--   ALTER TABLE public.quo_conversation_flags
--     DROP COLUMN IF EXISTS followed_up_by,
--     DROP COLUMN IF EXISTS followed_up_by_name;
-- =============================================================================

-- Who claimed an item as handled (name denormalised like the rest of the app's
-- audit trail, so the list does not need a profiles join at read time).
ALTER TABLE public.quo_conversation_flags
  ADD COLUMN IF NOT EXISTS followed_up_by      uuid,
  ADD COLUMN IF NOT EXISTS followed_up_by_name text;

-- Supports the window filter on the customer's last inbound time.
CREATE INDEX IF NOT EXISTS idx_quo_conversations_last_customer_message_at
  ON public.quo_conversations (last_customer_message_at DESC)
  WHERE last_customer_message_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- list_cs_missed_followups: the follow-up list for one time window.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_cs_missed_followups(
  p_since      timestamptz DEFAULT NULL,
  p_until      timestamptz DEFAULT NULL,
  p_number_ids uuid[]      DEFAULT NULL
)
RETURNS TABLE (
  conversation_id        uuid,
  quo_conversation_id    text,
  customer_name          text,
  customer_number        text,
  number_id              uuid,
  quo_phone_number_id    text,
  number                 text,
  number_name            text,
  number_label           text,
  number_display         text,
  type                   text,
  is_new_lead            boolean,
  last_customer_at       timestamptz,
  last_agent_at          timestamptz,
  waited_minutes         integer,
  preview                text,
  triage_status          text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_since timestamptz := COALESCE(p_since, now() - interval '24 hours');
  v_until timestamptz := COALESCE(p_until, now());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'cs_admin'::app_role)
    OR public.has_role(v_uid, 'customer_service'::app_role)
  ) THEN
    RAISE EXCEPTION 'You do not have access to the AI Assistance follow-up list'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH cs_numbers AS (
    SELECT pn.id
    FROM public.quo_phone_numbers pn
    WHERE regexp_replace(COALESCE(pn.number, pn.display_number, ''), '\D', '', 'g') !~ '7475887812$'
      AND (p_number_ids IS NULL OR pn.id = ANY (p_number_ids))
  ),
  candidates AS (
    SELECT c.id,
           c.quo_conversation_id   AS qc_id,
           c.customer_name         AS cust_name,
           c.customer_number       AS cust_number,
           c.number_id             AS num_id,
           c.last_customer_message_at AS last_cust_at,
           c.last_agent_message_at    AS last_agent_at,
           c.last_message_preview  AS msg_preview,
           COALESCE(NULLIF(c.current_status, ''), c.status) AS triage
    FROM public.quo_conversations c
    JOIN cs_numbers n ON n.id = c.number_id
    LEFT JOIN public.quo_conversation_flags f ON f.conversation_id = c.id
    WHERE c.last_customer_message_at IS NOT NULL
      AND (c.last_agent_message_at IS NULL
           OR c.last_agent_message_at < c.last_customer_message_at)
      AND c.last_customer_message_at >= v_since
      AND c.last_customer_message_at <= v_until
      -- Hide items a CS member has already claimed as handled, unless the
      -- customer has since made contact again.
      AND (f.followed_up_at IS NULL
           OR f.followed_up_at < c.last_customer_message_at)
  ),
  latest_inbound AS (
    SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id,
           m.quo_message_id AS qm_id,
           m.status         AS msg_status
    FROM public.quo_messages m
    JOIN candidates cd ON cd.id = m.conversation_id
    WHERE lower(COALESCE(m.direction, '')) IN ('inbound', 'incoming')
      AND m.quo_message_id NOT LIKE '%:call.transcript.completed'
      AND m.quo_message_id NOT LIKE '%:call.summary.completed'
      AND m.quo_message_id NOT LIKE '%:call.recording.completed'
    ORDER BY m.conversation_id, m.message_time DESC NULLS LAST
  )
  SELECT
    cd.id,
    cd.qc_id,
    cd.cust_name,
    cd.cust_number,
    cd.num_id,
    pn.quo_phone_number_id,
    pn.number,
    pn.name,
    pn.label,
    pn.display_number,
    CASE
      WHEN li.qm_id LIKE '%:call.completed' AND li.msg_status = 'no-answer' THEN 'missed_call'
      ELSE 'unanswered_text'
    END AS type,
    (cd.last_agent_at IS NULL) AS is_new_lead,
    cd.last_cust_at,
    cd.last_agent_at,
    GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - cd.last_cust_at)) / 60))::int AS waited_minutes,
    cd.msg_preview,
    cd.triage
  FROM candidates cd
  JOIN public.quo_phone_numbers pn ON pn.id = cd.num_id
  LEFT JOIN latest_inbound li ON li.conversation_id = cd.id
  -- Drop answered inbound calls (connected, likely handled live) — not a miss.
  -- A null latest-inbound row is kept and treated as an unanswered text.
  WHERE COALESCE(
          li.qm_id LIKE '%:call.completed' AND li.msg_status IS DISTINCT FROM 'no-answer',
          false
        ) = false
  ORDER BY cd.last_cust_at ASC;  -- longest-waiting first
END;
$function$;

-- -----------------------------------------------------------------------------
-- get_cs_missed_followup_count: badge count for the same window (same gate).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cs_missed_followup_count(
  p_since      timestamptz DEFAULT NULL,
  p_until      timestamptz DEFAULT NULL,
  p_number_ids uuid[]      DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT count(*)::int
  FROM public.list_cs_missed_followups(p_since, p_until, p_number_ids);
$function$;

-- -----------------------------------------------------------------------------
-- mark_cs_followup_handled: claim (or un-claim) an item as handled.
-- SECURITY DEFINER so cs_admin can write too (the flags RLS omits cs_admin).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_cs_followup_handled(
  p_conversation_id uuid,
  p_handled         boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'cs_admin'::app_role)
    OR public.has_role(v_uid, 'customer_service'::app_role)
  ) THEN
    RAISE EXCEPTION 'You do not have access to the AI Assistance follow-up list'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.quo_conversations WHERE id = p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation % not found', p_conversation_id USING ERRCODE = 'P0002';
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.quo_conversation_flags AS f (conversation_id, followed_up_at, followed_up_by, followed_up_by_name)
  VALUES (
    p_conversation_id,
    CASE WHEN p_handled THEN now() ELSE NULL END,
    CASE WHEN p_handled THEN v_uid ELSE NULL END,
    CASE WHEN p_handled THEN v_name ELSE NULL END
  )
  ON CONFLICT (conversation_id) DO UPDATE
    SET followed_up_at      = EXCLUDED.followed_up_at,
        followed_up_by      = EXCLUDED.followed_up_by,
        followed_up_by_name = EXCLUDED.followed_up_by_name,
        updated_at          = now();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_cs_missed_followups(timestamptz, timestamptz, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cs_missed_followup_count(timestamptz, timestamptz, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_cs_followup_handled(uuid, boolean) TO authenticated;
