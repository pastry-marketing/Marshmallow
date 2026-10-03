-- =============================================================================
-- Migration : 20261104000000_urgent_review_gate.sql
-- Purpose   : Require an AI-checked conversation, and a human sign-off, before
--             a customer-service user can move a lead into urgent_job.
--
-- WHY THIS IS A DATABASE GATE AND NOT A DIALOG
--
--   The obvious design intercepts the status change in the lead form and in
--   the extension, then shows the discrepancies. That would be cosmetic.
--
--   The existing policy "Authorized users can update leads" already permits a
--   customer_service user who created or is assigned the lead to UPDATE the row,
--   and row level security filters rows rather than columns. So one direct
--   REST call sets status to urgent_job and skips any dialog entirely.
--
--   Verified against the live database before writing this file. The trigger
--   below is what actually holds the line; the dialog is the friendly version
--   of the same rule.
--
-- WHAT PASSES WITHOUT REVIEW
--
--   admin, processor and cs_admin. Admin is the escalation path and a broken
--   gate with no override strands urgent work. Processor already schedules and
--   dispatches. cs_admin is senior enough to be asked directly.
--
--   customer_service must go through the AI check, and if the check finds a
--   discrepancy, through a CS Admin or Admin review.
--
--   cs_admin may not approve their own request. An override is only meaningful
--   if a second pair of eyes signs it off.
--
-- SCHEDULE IS NEVER TOUCHED
--
--   Urgent means dispatch priority. It must not move a job's date or time: the
--   whole point of one of the checks is that the recorded schedule matches what
--   the customer agreed to. Nothing in this file writes scheduled_date,
--   scheduled_time_start, or customer_schedule_requirements.
--
--   The existing trg_set_lead_urgent_at trigger stamps urgent_at on the
--   transition, which is left alone.
--
-- PERMISSIONS
--
--   RESET ALL is used in preference to REVOKE ... FROM PUBLIC. An earlier
--   migration in this project used REVOKE and reported success while changing
--   nothing, because the functions carried Postgres's default world grant
--   rather than a PUBLIC group entry. RESET ALL then an explicit GRANT cannot
--   be a no-op.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The review queue
--    Column shape follows lead_quote_approval_requests and the technician
--    change queue, including its vocabulary where they overlap.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_urgent_review_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  -- Snapshots so a card still reads correctly after the lead changes or, for a
  -- new lead, before it is approved and created.
  previous_status     text NOT NULL,
  lead_job_id         text,
  lead_customer_name  text,
  requested_by        uuid,
  requested_by_name   text,
  -- Only the failures, never the passes. A list of nine green ticks is noise;
  -- the reason this queue exists is the things that are wrong.
  ai_issues           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_summary          text,
  ai_model            text,
  ai_checked_at       timestamptz,
  status              text NOT NULL DEFAULT 'pending',
  reviewed_by         uuid,
  reviewed_by_name    text,
  reviewed_at         timestamptz,
  review_note         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_urgent_review_status
    CHECK (status IN ('pending', 'approved', 'declined'))
);

COMMENT ON TABLE public.lead_urgent_review_requests IS
  'customer_service requests to move a lead to urgent_job. Rows exist only when '
  'the AI check found a discrepancy. Approval writes leads.status; it never '
  'touches the agreed schedule.';

-- One open request per lead, so a CS member cannot stack requests and bury the
-- queue, and so approval cannot be ambiguous about which request it answered.
CREATE UNIQUE INDEX IF NOT EXISTS lead_urgent_review_one_pending_per_lead
  ON public.lead_urgent_review_requests (lead_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lead_urgent_review_pending_created
  ON public.lead_urgent_review_requests (created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lead_urgent_review_requester
  ON public.lead_urgent_review_requests (requested_by, created_at DESC);


-- -----------------------------------------------------------------------------
-- 2. updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_urgent_review_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS lead_urgent_review_updated_at
  ON public.lead_urgent_review_requests;

CREATE TRIGGER lead_urgent_review_updated_at
  BEFORE UPDATE ON public.lead_urgent_review_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_urgent_review_updated_at();


-- -----------------------------------------------------------------------------
-- 3. THE GATE
--    customer_service cannot move a lead into urgent_job directly. They must
--    either go through the AI check, which mints an approved verification, or
--    ask a reviewer.
--
--    The escape hatch is a transaction-local flag set only by
--    approve_urgent_verification(). A client cannot set it: PostgREST exposes
--    RPC functions, not arbitrary SET.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_urgent_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_bypass  boolean;
BEGIN
  -- Roles that dispatch work and can be asked directly.
  v_bypass := public.has_role(v_uid, 'admin'::app_role)
           OR public.has_role(v_uid, 'processor'::app_role)
           OR public.has_role(v_uid, 'cs_admin'::app_role);

  IF TG_OP = 'INSERT' THEN
    -- A lead created straight into urgent_job.
    --
    -- This arm exists because the trigger was originally BEFORE UPDATE only,
    -- which left the creation path open: the Chrome extension posts a draft with
    -- a status field, and one direct insert with status urgent_job skipped the
    -- gate entirely. An UPDATE-only trigger protects an existing row and nothing
    -- else.
    --
    -- The verification flag is deliberately not honoured here. Verifying a record
    -- means reading it back from the database, so there is nothing to verify at
    -- the moment of the insert. The way through is to create the lead in its
    -- ordinary status and then run the check against it, which is what the add
    -- dialog and the extension both do.
    IF NEW.status = 'urgent_job' AND NOT v_bypass THEN
      RAISE EXCEPTION
        'A new lead cannot be created as urgent. Create it first, then run the AI check before making it urgent.'
        USING ERRCODE = '42501',
              HINT = 'Create the lead in its normal status, then use the urgent check.';
    END IF;

    RETURN NEW;
  END IF;

  -- Not a transition into urgent. Both conditions must fail for the gate to
  -- apply, so an edit to a lead that is already urgent is not blocked.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'urgent_job' THEN
    RETURN NEW;
  END IF;

  IF v_bypass THEN
    RETURN NEW;
  END IF;

  -- Applying a verification the AI check already produced, or a review a
  -- human approved. The flag is transaction-local and only these two functions
  -- set it.
  IF current_setting('app.urgent_verified', true) = 'on' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'This lead must pass the AI verification check before it can become urgent. Raise an urgent review request instead.'
    USING ERRCODE = '42501',
          HINT = 'Use the AI check on the lead, or send it to a CS Admin for review.';
END;
$fn$;

COMMENT ON FUNCTION public.enforce_urgent_gate() IS
  'Blocks customer_service from creating a lead as urgent_job, and from moving '
  'one into urgent_job without a verified AI check or a human review. Covers '
  'INSERT as well as UPDATE: row level security filters rows, not columns, so '
  'the creation path needs the same protection as the update path.';

DROP TRIGGER IF EXISTS leads_urgent_gate ON public.leads;

CREATE TRIGGER leads_urgent_gate
  BEFORE INSERT OR UPDATE OF status ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_urgent_gate();


-- -----------------------------------------------------------------------------
-- 4. Record an AI verification that passed
--    Called by the edge function's client step once the model reports no
--    issues. This is what lets a clean lead become urgent without a human.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_urgent_verification(
  p_lead_id   uuid,
  p_ai_summary text DEFAULT NULL,
  p_ai_model   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  v_role := COALESCE(
    (SELECT role::text FROM public.user_roles WHERE user_id = v_uid ORDER BY role LIMIT 1),
    ''
  );

  IF v_role <> 'customer_service' THEN
    -- Anyone who can already bypass the gate does not need a verification.
    RETURN;
  END IF;

  -- Only meaningful for a lead this user can actually see, which is the same
  -- test the leads policy applies. Without it, a verification could be minted
  -- for an arbitrary lead id.
  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.id = p_lead_id
         AND (l.created_by = v_uid OR l.assigned_cs = v_uid)
    )
  ) THEN
    RAISE EXCEPTION 'You cannot verify a lead you do not have access to'
      USING ERRCODE = '42501';
  END IF;

  -- Row lock first, so the flag cannot outlive a concurrent review.
  PERFORM 1 FROM public.leads WHERE id = p_lead_id FOR UPDATE;

  PERFORM set_config('app.urgent_verified', 'on', true);
  UPDATE public.leads
     SET status = 'urgent_job',
         last_edited_by      = v_uid,
         last_edited_by_name = COALESCE(
           (SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service'),
         last_edited_at = now(),
         updated_at     = now()
   WHERE id = p_lead_id
     AND status IS DISTINCT FROM 'urgent_job';
  PERFORM set_config('app.urgent_verified', 'off', true);

  INSERT INTO public.activity_logs (
    user_id, user_name, action, target_type, target_id, details
  )
  VALUES (
    v_uid,
    COALESCE((SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service'),
    'urgent_verified',
    'lead',
    p_lead_id,
    jsonb_build_object(
      'ai_summary', coalesce(p_ai_summary, 'All verification checks passed'),
      'ai_model',   p_ai_model
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Never leave the flag set, whatever happened above it.
  PERFORM set_config('app.urgent_verified', 'off', true);
  RAISE;
END;
$fn$;

COMMENT ON FUNCTION public.approve_urgent_verification(uuid, text, text) IS
  'Applies urgent_job for a customer_service user whose AI check found nothing. '
  'Sets a transaction-local flag the gate trigger honours.';


-- -----------------------------------------------------------------------------
-- 4b. Acknowledge that verification was not possible
--     Separate from approve_urgent_verification on purpose.
--
--     44% of leads have no matched conversation, and those cannot be checked at
--     all. Blocking them would send nearly half of urgent work to a human queue
--     permanently, and a queue that is mostly noise is a queue nobody reads.
--     Letting them through unchecked would be worse: the activity log would claim
--     a check passed when none ran.
--
--     So the gate admits them only after a person has been shown "this could not
--     be checked" and has said yes on purpose. The activity trail records it as
--     an acknowledgement, never as a passed check, so the distinction survives
--     into reporting.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_urgent_acknowledgement(
  p_lead_id uuid,
  p_reason  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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
    OR public.has_role(v_uid, 'processor'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.id = p_lead_id
         AND (l.created_by = v_uid OR l.assigned_cs = v_uid)
    )
  ) THEN
    RAISE EXCEPTION 'You cannot approve a lead you do not have access to'
      USING ERRCODE = '42501';
  END IF;

  v_name := COALESCE((SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service');

  PERFORM set_config('app.urgent_verified', 'on', true);
  UPDATE public.leads
     SET status              = 'urgent_job',
         last_edited_by      = v_uid,
         last_edited_by_name = v_name,
         last_edited_at      = now(),
         updated_at          = now()
   WHERE id = p_lead_id;
  PERFORM set_config('app.urgent_verified', 'off', true);

  INSERT INTO public.activity_logs (
    user_id, user_name, action, target_type, target_id, details
  )
  VALUES (
    v_uid, v_name, 'urgent_unverified_acknowledged', 'lead', p_lead_id,
    jsonb_build_object(
      'verified', false,
      'reason',   left(coalesce(p_reason, 'No conversation available to check'), 300)
    )
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.urgent_verified', 'off', true);
  RAISE;
END;
$fn$;

COMMENT ON FUNCTION public.approve_urgent_acknowledgement(uuid, text) IS
  'Applies urgent_job after a person explicitly accepted that no verification '
  'was possible. Logs an acknowledgement, never a passed check.';


-- -----------------------------------------------------------------------------
-- 5. Raise a review request
--    Used when the AI found something. The lead stays where it is.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_urgent_review(
  p_lead_id     uuid,
  p_ai_issues   jsonb DEFAULT '[]'::jsonb,
  p_ai_summary  text DEFAULT NULL,
  p_ai_model    text DEFAULT NULL,
  p_lead_job_id text DEFAULT NULL,
  p_lead_customer_name text DEFAULT NULL,
  p_previous_status text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_name      text;
  v_lead      record;
  v_request   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  SELECT id, status, job_id, customer_name INTO v_lead
    FROM public.leads
   WHERE id = p_lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'P0002';
  END IF;

  -- Same access test as the leads policy, so a request cannot be raised for a
  -- lead the requester cannot see.
  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'cs_admin'::app_role)
    OR public.has_role(v_uid, 'processor'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.id = p_lead_id
         AND (l.created_by = v_uid OR l.assigned_cs = v_uid)
    )
  ) THEN
    RAISE EXCEPTION 'You cannot request review for a lead you do not have access to'
      USING ERRCODE = '42501';
  END IF;

  v_name := COALESCE((SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service');

  INSERT INTO public.lead_urgent_review_requests (
    lead_id, previous_status, lead_job_id, lead_customer_name,
    requested_by, requested_by_name,
    ai_issues, ai_summary, ai_model, ai_checked_at
  )
  VALUES (
    p_lead_id,
    COALESCE(p_previous_status, v_lead.status, 'unknown'),
    COALESCE(p_lead_job_id, v_lead.job_id),
    COALESCE(p_lead_customer_name, v_lead.customer_name),
    v_uid,
    v_name,
    COALESCE(p_ai_issues, '[]'::jsonb),
    p_ai_summary,
    p_ai_model,
    now()
  )
  ON CONFLICT (lead_id) WHERE status = 'pending'
  DO UPDATE SET
    ai_issues    = EXCLUDED.ai_issues,
    ai_summary   = EXCLUDED.ai_summary,
    ai_model     = EXCLUDED.ai_model,
    ai_checked_at= now(),
    updated_at   = now()
  RETURNING id INTO v_request;

  -- Tell the reviewers.
  INSERT INTO public.notifications (user_id, title, message)
  SELECT ur.user_id,
         '[Review] Lead needs urgent approval',
         format(
           '%s raised an urgent request for %s. %s',
           v_name,
           COALESCE(v_lead.job_id, v_lead.customer_name, 'a lead'),
           COALESCE(left(p_ai_summary, 200), 'The AI check found discrepancies.')
         )
    FROM public.user_roles ur
   WHERE ur.role IN ('cs_admin', 'admin')
     AND ur.user_id IS DISTINCT FROM v_uid;

  RETURN v_request;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$fn$;

COMMENT ON FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text) IS
  'Queues a lead for CS Admin review without changing its status.';


-- -----------------------------------------------------------------------------
-- 6. Approve or decline
--    Approval writes urgent_job through the gate's own flag, so the trigger
--    sees a verified transition rather than an unexplained one.
--
--    The schedule columns are not in the SET list. Deliberate: Urgent is
--    dispatch priority, and one of the checks this workflow exists to catch is
--    a schedule that disagrees with the customer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_urgent_request(
  p_request_id  uuid,
  p_approve     boolean,
  p_review_note text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_name     text;
  v_request  record;
  v_target   uuid;
  v_was_urgent boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'cs_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only a CS Admin or Admin may review urgent requests'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_request
    FROM public.lead_urgent_review_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Urgent review request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already %s', v_request.status USING ERRCODE = '22023';
  END IF;

  -- Self-approval defeats the point of a second pair of eyes. An admin is
  -- exempt because they can already set urgent directly and are the escalation.
  IF v_request.requested_by = v_uid
     AND NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'You cannot approve a request you raised yourself. Ask another CS Admin or an Admin.'
      USING ERRCODE = '42501';
  END IF;

  v_name := COALESCE((SELECT full_name FROM public.profiles WHERE id = v_uid), 'CS Admin');
  v_target := v_request.lead_id;

  IF p_approve THEN
    SELECT status = 'urgent_job' INTO v_was_urgent
      FROM public.leads WHERE id = v_target FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The lead no longer exists' USING ERRCODE = 'P0002';
    END IF;

    -- Marked urgent before the flag is set, so the gate admits this one write
    -- and nothing else in the transaction slips through on the back of it.
    UPDATE public.lead_urgent_review_requests
       SET status           = 'approved',
           reviewed_by       = v_uid,
           reviewed_by_name  = v_name,
           reviewed_at       = now(),
           review_note       = left(coalesce(p_review_note, ''), 500)
     WHERE id = p_request_id;

    IF NOT v_was_urgent THEN
      PERFORM set_config('app.urgent_verified', 'on', true);
      -- status only. scheduled_date, scheduled_time_start and
      -- customer_schedule_requirements are deliberately untouched.
      UPDATE public.leads
         SET status              = 'urgent_job',
             last_edited_by      = v_uid,
             last_edited_by_name = v_name,
             last_edited_at      = now(),
             updated_at          = now()
       WHERE id = v_target;
      PERFORM set_config('app.urgent_verified', 'off', true);
    END IF;

    -- Tell the requester.
    INSERT INTO public.notifications (user_id, title, message)
    VALUES (
      v_request.requested_by,
      '[Approved] Urgent request',
      format('%s approved your urgent request for %s.%s',
             v_name,
             COALESCE(v_request.lead_job_id, v_request.lead_customer_name, 'the lead'),
             CASE WHEN coalesce(p_review_note, '') <> ''
                  THEN format(' Note: %s', p_review_note) ELSE '' END)
    );

    INSERT INTO public.activity_logs (user_id, user_name, action, target_type, target_id, details)
    VALUES (
      v_uid, v_name, 'urgent_review_approved', 'lead', v_target,
      jsonb_build_object('request_id', p_request_id, 'note', p_review_note)
    );

    RETURN 'Approved. The lead is now urgent. The agreed schedule was not changed.';
  END IF;

  UPDATE public.lead_urgent_review_requests
     SET status          = 'declined',
         reviewed_by      = v_uid,
         reviewed_by_name = v_name,
         reviewed_at      = now(),
         review_note      = left(coalesce(p_review_note, ''), 500)
   WHERE id = p_request_id;

  INSERT INTO public.notifications (user_id, title, message)
  SELECT v_request.requested_by,
         '[Declined] Urgent request',
         format('%s declined your urgent request for %s.%s',
                v_name,
                COALESCE(v_request.lead_job_id, v_request.lead_customer_name, 'the lead'),
                CASE WHEN coalesce(p_review_note, '') <> ''
                     THEN format(' Reason: %s', p_review_note) ELSE '' END);

INSERT INTO public.activity_logs (user_id, user_name, action, target_type, target_id, details)
    VALUES (
      v_uid, v_name, 'urgent_review_declined', 'lead', v_target,
      jsonb_build_object('request_id', p_request_id, 'note', p_review_note)
    );

  RETURN 'Declined. The lead keeps its current status.';
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.urgent_verified', 'off', true);
  RAISE;
END;
$fn$;

COMMENT ON FUNCTION public.review_urgent_request(uuid, boolean, text) IS
  'Approves or declines an urgent request. Approval sets urgent_job and leaves '
  'the agreed schedule alone. A cs_admin cannot approve their own request.';


-- -----------------------------------------------------------------------------
-- 7. Read the queue
--    Joins the live lead so a reviewer sees whether it is already urgent and
--    whether the CS member has since corrected the flagged fields.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_urgent_review_requests(
  p_status text DEFAULT 'pending'
)
RETURNS TABLE (
  id                 uuid,
  lead_id            uuid,
  previous_status    text,
  lead_job_id        text,
  lead_customer_name text,
  requested_by       uuid,
  requested_by_name  text,
  ai_issues          jsonb,
  ai_summary         text,
  ai_model           text,
  status             text,
  reviewed_by_name   text,
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz,
  current_status     text,
  current_service_details  text,
  current_customer_schedule_requirements text,
  current_quote      text,
  current_terms      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT r.id, r.lead_id, r.previous_status, r.lead_job_id, r.lead_customer_name,
         r.requested_by, r.requested_by_name, r.ai_issues, r.ai_summary,
         r.ai_model, r.status, r.reviewed_by_name, r.reviewed_at, r.review_note,
         r.created_at,
         l.status, l.service_details, l.customer_schedule_requirements,
         l.quote, l.terms
    FROM public.lead_urgent_review_requests r
    LEFT JOIN public.leads l ON l.id = r.lead_id
   WHERE r.status = COALESCE(p_status, 'pending')
   ORDER BY r.created_at;
$fn$;


-- -----------------------------------------------------------------------------
-- 8. RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.lead_urgent_review_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Requesters raise urgent reviews" ON public.lead_urgent_review_requests;
CREATE POLICY "Requesters raise urgent reviews"
  ON public.lead_urgent_review_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (public.has_role(auth.uid(), 'admin'::app_role)
     OR public.has_role(auth.uid(), 'cs_admin'::app_role)
     OR public.has_role(auth.uid(), 'processor'::app_role)
     OR requested_by = auth.uid())
  );

DROP POLICY IF EXISTS "Reviewers read urgent reviews" ON public.lead_urgent_review_requests;
CREATE POLICY "Reviewers read urgent reviews"
  ON public.lead_urgent_review_requests
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'cs_admin'::app_role)
    OR requested_by = auth.uid()
  );

DROP POLICY IF EXISTS "Reviewers update urgent reviews" ON public.lead_urgent_review_requests;
CREATE POLICY "Reviewers update urgent reviews"
  ON public.lead_urgent_review_requests
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'cs_admin'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'cs_admin'::app_role)
  );


-- -----------------------------------------------------------------------------
-- 9. Realtime, so the queue count and cards update without a refresh
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'lead_urgent_review_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_urgent_review_requests;
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 10. Grants
--     RESET ALL rather than REVOKE FROM PUBLIC: the default world grant is not
--     a PUBLIC group entry on this database and REVOKE silently does nothing.
-- -----------------------------------------------------------------------------
ALTER TABLE public.lead_urgent_review_requests RESET ALL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_urgent_review_requests
  TO authenticated;

ALTER FUNCTION public.enforce_urgent_gate()             RESET ALL;
ALTER FUNCTION public.approve_urgent_verification(uuid, text, text) RESET ALL;
ALTER FUNCTION public.approve_urgent_acknowledgement(uuid, text) RESET ALL;
ALTER FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text) RESET ALL;
ALTER FUNCTION public.review_urgent_request(uuid, boolean, text) RESET ALL;
ALTER FUNCTION public.list_urgent_review_requests(text) RESET ALL;
ALTER FUNCTION public.set_urgent_review_updated_at()   RESET ALL;

GRANT EXECUTE ON FUNCTION public.enforce_urgent_gate() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_urgent_verification(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_urgent_acknowledgement(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_urgent_request(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_urgent_review_requests(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_urgent_review_updated_at() TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP TRIGGER IF EXISTS leads_urgent_gate ON public.leads;
--   DROP FUNCTION IF EXISTS public.enforce_urgent_gate();
--   DROP TRIGGER IF EXISTS lead_urgent_review_updated_at
--     ON public.lead_urgent_review_requests;
--   DROP FUNCTION IF EXISTS public.set_urgent_review_updated_at();
--   DROP FUNCTION IF EXISTS public.list_urgent_review_requests(text);
--   DROP FUNCTION IF EXISTS public.review_urgent_request(uuid, boolean, text);
--   DROP FUNCTION IF EXISTS public.request_urgent_review(uuid, jsonb, text, text, text, text, text);
--   DROP FUNCTION IF EXISTS public.approve_urgent_acknowledgement(uuid, text);
--   DROP FUNCTION IF EXISTS public.approve_urgent_verification(uuid, text, text);
--   DROP TABLE IF EXISTS public.lead_urgent_review_requests;
--
-- Dropping leads_urgent_gate is the important line. Until it exists a
-- customer_service user can set urgent_job directly, which is what happens
-- today. No lead row is modified either way.
-- =============================================================================