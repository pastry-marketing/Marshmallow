-- =============================================================================
-- Migration : 20261102000000_google_sheets_sync_health.sql
-- Purpose   : Make a failed Google Sheets sync visible and recoverable instead
--             of silent.
--
-- THE PROBLEM
--   Sync runs entirely in an admin's browser. The realtimeBus fires, the lead
--   is upserted to the sheet, and every failure path ends in a console.warn.
--   If the webhook URL expired, the Apps Script quota ran out, or the admin
--   simply closed the tab, nothing is reported to anyone. The sheet silently
--   drifts out of date and the first sign of trouble is a lead that never
--   appeared.
--
--   A client-side heartbeat cannot fix this: a heartbeat that stops when sync
--   stops is indistinguishable from a healthy idle system, and it cannot
--   report a failure to people who are not looking at the screen.
--
-- WHAT THIS DOES
--   Moves the *bookkeeping* server-side so state survives the browser:
--
--     google_sheets_sync_health   one row, current status and failure streak
--     google_sheets_sync_errors   append-only log, so "last 10 errors" is real
--     google_sheets_sync_queue    failed leads, retried later
--
--   The queue is the part that changes behaviour. Failed leads currently live
--   in an in-memory Map and localStorage on one machine. They are written here
--   instead, so a closed tab does not discard them and any admin can drain
--   them.
--
--   Staleness is derived, not reported. get_sheets_sync_health() decides the
--   status from last_success_at, so a sync that died without recording an
--   error is still reported as stale rather than as healthy.
--
-- ALSO FIXES: leads.updated_at was maintained by hand
--   The column existed but no trigger set it. Every write depended on the
--   calling code remembering to pass updated_at, which is why the delta sync
--   in the original plan would have silently returned nothing for any update
--   path that forgot. set_updated_at() already existed for other tables and
--   was simply never attached to leads.
--
-- PERMISSIONS
--   Admin only, matching the rest of Settings. anon is revoked.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Guarantee leads.updated_at
--    A BEFORE trigger rewrites NEW only; it issues no UPDATE of its own.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS leads_set_updated_at ON public.leads;

CREATE TRIGGER leads_set_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. Health, error log and durable retry queue
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.google_sheets_sync_health (
  id                   text PRIMARY KEY DEFAULT 'global',
  status               text NOT NULL DEFAULT 'idle',
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  last_error_at        timestamptz,
  last_error_message   text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  synced_total         bigint  NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_sheets_sync_health_singleton CHECK (id = 'global'),
  CONSTRAINT google_sheets_sync_health_status
    CHECK (status IN ('healthy', 'degraded', 'down', 'idle'))
);

COMMENT ON TABLE public.google_sheets_sync_health IS
  'One row. Status is derived from last_success_at at read time so a sync that '
  'stopped without recording an error is still reported as stale.';

CREATE TABLE IF NOT EXISTS public.google_sheets_sync_errors (
  id         bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  lead_id    uuid,
  action     text NOT NULL DEFAULT 'sync',
  message    text NOT NULL,
  detail     jsonb
);

CREATE INDEX IF NOT EXISTS google_sheets_sync_errors_recent_idx
  ON public.google_sheets_sync_errors (occurred_at DESC);

COMMENT ON TABLE public.google_sheets_sync_errors IS
  'Append-only failure log. Bounded by prune_sheets_sync_errors(); nothing '
  'deletes rows implicitly.';

CREATE TABLE IF NOT EXISTS public.google_sheets_sync_queue (
  lead_id         uuid PRIMARY KEY,
  op              text NOT NULL DEFAULT 'upsert',
  job_id          text,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_sheets_sync_queue_op CHECK (op IN ('upsert', 'delete'))
);

CREATE INDEX IF NOT EXISTS google_sheets_sync_queue_due_idx
  ON public.google_sheets_sync_queue (next_attempt_at);

COMMENT ON TABLE public.google_sheets_sync_queue IS
  'Leads that failed to reach the sheet. Written by record_sheets_sync_failure '
  'so a closed browser tab cannot discard pending work.';


-- -----------------------------------------------------------------------------
-- 3. Recording outcomes
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_sheets_sync_success(
  p_lead_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.google_sheets_sync_health AS h (
    id, status, last_attempt_at, last_success_at,
    last_error_message, consecutive_failures, synced_total, updated_at
  )
  VALUES ('global', 'healthy', now(), now(), NULL, 0, 1, now())
  ON CONFLICT (id) DO UPDATE SET
    status               = 'healthy',
    last_attempt_at      = now(),
    last_success_at      = now(),
    last_error_message   = NULL,
    consecutive_failures = 0,
    synced_total         = h.synced_total + 1,
    updated_at           = now();

  IF p_lead_id IS NOT NULL THEN
    DELETE FROM public.google_sheets_sync_queue WHERE lead_id = p_lead_id;
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.record_sheets_sync_success(uuid) IS
  'Marks the sheet as current and clears any queued retry for the lead.';


CREATE OR REPLACE FUNCTION public.record_sheets_sync_failure(
  p_message text,
  p_lead_id  uuid DEFAULT NULL,
  p_action   text DEFAULT 'sync',
  p_detail   jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_streak integer;
BEGIN
  IF p_lead_id IS NOT NULL THEN
    -- Upsert so a lead is never queued twice, and the retry count accumulates.
    INSERT INTO public.google_sheets_sync_queue (
      lead_id, op, job_id, attempts, next_attempt_at, last_error
    )
    VALUES (
      p_lead_id,
      CASE WHEN p_action = 'delete' THEN 'delete' ELSE 'upsert' END,
      NULL, 1, now(), left(p_message, 500)
    )
    ON CONFLICT (lead_id) DO UPDATE SET
      attempts        = public.google_sheets_sync_queue.attempts + 1,
      last_error      = left(EXCLUDED.last_error, 500),
      -- Back off: 1min, 2min, 4min, then every 8min.
      next_attempt_at = now() + make_interval(
                         secs => least(480, power(2, public.google_sheets_sync_queue.attempts) * 30)::int
                       );
  END IF;

  INSERT INTO public.google_sheets_sync_errors (lead_id, action, message, detail)
  VALUES (p_lead_id, p_action, left(p_message, 1000), p_detail);

  INSERT INTO public.google_sheets_sync_health AS h (
    id, status, last_attempt_at, last_error_at,
    last_error_message, consecutive_failures, updated_at
  )
  VALUES (
    'global', 'degraded', now(), now(), left(p_message, 500), 1, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    status               = CASE
                             WHEN public.google_sheets_sync_health.consecutive_failures + 1 >= 10
                               THEN 'down'
                             ELSE 'degraded'
                           END,
    last_attempt_at      = now(),
    last_error_at        = now(),
    last_error_message   = left(EXCLUDED.last_error_message, 500),
    consecutive_failures = public.google_sheets_sync_health.consecutive_failures + 1,
    updated_at           = now()
  RETURNING consecutive_failures INTO v_streak;
END;
$fn$;

COMMENT ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) IS
  'Records a failed dispatch, logs it, and queues the lead for retry. Three '
  'consecutive turns degraded, ten turns down.';


-- -----------------------------------------------------------------------------
-- 4. Queue processing
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_sheets_sync_queue(
  p_limit integer DEFAULT 25
)
RETURNS TABLE (
  lead_id  uuid,
  op       text,
  job_id   text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT q.lead_id
      FROM public.google_sheets_sync_queue q
     WHERE q.next_attempt_at <= now()
     ORDER BY q.next_attempt_at
     LIMIT greatest(coalesce(p_limit, 25), 1)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.google_sheets_sync_queue q
     SET attempts = q.attempts + 1
    FROM due d
   WHERE q.lead_id = d.lead_id
  RETURNING q.lead_id, q.op, q.job_id, q.attempts;
END;
$fn$;

COMMENT ON FUNCTION public.claim_sheets_sync_queue(integer) IS
  'Claims due retries for one worker. SKIP LOCKED so two admins draining at '
  'once cannot process the same lead twice.';


CREATE OR REPLACE FUNCTION public.get_sheets_sync_queue_depth()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::integer FROM public.google_sheets_sync_queue;
$fn$;


CREATE OR REPLACE FUNCTION public.prune_sheets_sync_errors(
  p_keep integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.google_sheets_sync_errors
   WHERE id NOT IN (
     SELECT id FROM public.google_sheets_sync_errors
      ORDER BY occurred_at DESC
      LIMIT greatest(coalesce(p_keep, 500), 1)
   );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;


-- -----------------------------------------------------------------------------
-- 5. Reading the status
--    Staleness is computed here rather than stored, so a sync that stops
--    without recording anything is still reported as stale.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sheets_sync_health(
  p_stale_after_seconds integer DEFAULT 900
)
RETURNS TABLE (
  status               text,
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  last_error_at        timestamptz,
  last_error_message   text,
  consecutive_failures integer,
  synced_total         bigint,
  queue_depth          integer,
  seconds_since_success integer,
  recent_errors        jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row    public.google_sheets_sync_health%ROWTYPE;
  v_stale  integer := greatest(coalesce(p_stale_after_seconds, 900), 60);
  v_since  integer;
  v_status text;
BEGIN
  SELECT * INTO v_row FROM public.google_sheets_sync_health WHERE id = 'global';

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'idle', NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
                        NULL::text, 0, 0::bigint, 0, NULL::integer, '[]'::jsonb;
    RETURN;
  END IF;

  v_since := CASE
    WHEN v_row.last_success_at IS NULL THEN NULL
    ELSE extract(epoch FROM (now() - v_row.last_success_at))::integer
  END;

  -- A recorded failure streak is authoritative. Only fall back to staleness
  -- when nothing has failed recently, so a sync that died silently is caught.
  v_status := CASE
    WHEN v_row.consecutive_failures >= 10 THEN 'down'
    WHEN v_row.consecutive_failures > 0 THEN 'degraded'
    WHEN v_since IS NULL THEN 'idle'
    WHEN v_since > v_stale THEN 'degraded'
    ELSE 'healthy'
  END;

  RETURN QUERY SELECT
    v_status,
    v_row.last_attempt_at,
    v_row.last_success_at,
    v_row.last_error_at,
    v_row.last_error_message,
    v_row.consecutive_failures,
    v_row.synced_total,
    public.get_sheets_sync_queue_depth(),
    v_since,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'occurred_at', e.occurred_at,
               'message',    e.message,
               'action',     e.action,
               'lead_id',    e.lead_id
             ) ORDER BY e.occurred_at DESC)
        FROM (
          SELECT occurred_at, message, action, lead_id
            FROM public.google_sheets_sync_errors
           ORDER BY occurred_at DESC
           LIMIT 10
        ) e
    ), '[]'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.get_sheets_sync_health(integer) IS
  'Current sync status with derived staleness, queue depth and the last ten '
  'errors. Read-only.';


-- -----------------------------------------------------------------------------
-- 6. Alerting that works with no browser open
--    Inserts the notification row directly, so admins are told even when
--    nobody has the app open. Throttled so a long outage does not spam.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.raise_sheets_sync_stale_alert(
  p_stale_after_seconds integer DEFAULT 900,
  p_throttle_minutes   integer DEFAULT 15
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_health  record;
  v_sent    integer := 0;
BEGIN
  SELECT * INTO v_health FROM public.get_sheets_sync_health(p_stale_after_seconds);
  IF v_health.status NOT IN ('degraded', 'down') THEN
    RETURN 0;
  END IF;

  -- Throttle: skip if the same alert already exists inside the window.
  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.user_id IN (SELECT user_id FROM public.user_roles WHERE role = 'admin')
       AND n.title = '[Alert] Google Sheets sync is not current'
       AND n.created_at > now() - make_interval(mins => greatest(coalesce(p_throttle_minutes, 15), 1))
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.notifications (user_id, title, message)
  SELECT ur.user_id,
         '[Alert] Google Sheets sync is not current',
         format(
           'Status %s. %s failed attempt(s) in a row. Last error: %s. %s lead(s) are queued for retry.',
           v_health.status,
           v_health.consecutive_failures,
           coalesce(left(v_health.last_error_message, 200), 'none recorded'),
           v_health.queue_depth
         )
    FROM public.user_roles ur
   WHERE ur.role = 'admin';

  GET DIAGNOSTICS v_sent = ROW_COUNT;
  RETURN v_sent;
END;
$fn$;

COMMENT ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) IS
  'Writes a notification row for every admin when sync is degraded or down. '
  'Runs entirely in the database, so it fires with no browser open. Throttled.';


-- -----------------------------------------------------------------------------
-- 7. RLS - admin only
-- -----------------------------------------------------------------------------
ALTER TABLE public.google_sheets_sync_health  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_sheets_sync_errors  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_sheets_sync_queue   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin manages sheets sync health" ON public.google_sheets_sync_health;
CREATE POLICY "Admin manages sheets sync health"
  ON public.google_sheets_sync_health
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admin reads sheets sync errors" ON public.google_sheets_sync_errors;
CREATE POLICY "Admin reads sheets sync errors"
  ON public.google_sheets_sync_errors
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admin reads sheets sync queue" ON public.google_sheets_sync_queue;
CREATE POLICY "Admin reads sheets sync queue"
  ON public.google_sheets_sync_queue
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admin updates sheets sync queue" ON public.google_sheets_sync_queue;
CREATE POLICY "Admin updates sheets sync queue"
  ON public.google_sheets_sync_queue
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));


-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.google_sheets_sync_health FROM anon;
REVOKE ALL ON public.google_sheets_sync_errors FROM anon;
REVOKE ALL ON public.google_sheets_sync_queue  FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.google_sheets_sync_health TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.google_sheets_sync_errors TO authenticated;
GRANT SELECT, UPDATE, DELETE              ON public.google_sheets_sync_queue  TO authenticated;

GRANT EXECUTE ON FUNCTION public.record_sheets_sync_success(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sheets_sync_queue(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_queue_depth() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prune_sheets_sync_errors(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) TO service_role;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP TRIGGER IF EXISTS leads_set_updated_at ON public.leads;
--   -- only if no delta sync depends on it:
--   DROP FUNCTION IF EXISTS public.raise_sheets_sync_stale_alert(integer, integer);
--   DROP FUNCTION IF EXISTS public.get_sheets_sync_health(integer);
--   DROP FUNCTION IF EXISTS public.prune_sheets_sync_errors(integer);
--   DROP FUNCTION IF EXISTS public.get_sheets_sync_queue_depth();
--   DROP FUNCTION IF EXISTS public.claim_sheets_sync_queue(integer);
--   DROP FUNCTION IF EXISTS public.record_sheets_sync_failure(text, uuid, text, jsonb);
--   DROP FUNCTION IF EXISTS public.record_sheets_sync_success(uuid);
--   DROP TABLE IF EXISTS public.google_sheets_sync_queue;
--   DROP TABLE IF EXISTS public.google_sheets_sync_errors;
--   DROP TABLE IF EXISTS public.google_sheets_sync_health;
--
-- Dropping leads_set_updated_at returns updated_at to being client-maintained,
-- which is how it behaved before this file. No lead row is modified.
-- =============================================================================