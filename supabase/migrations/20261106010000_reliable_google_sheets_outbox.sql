-- =============================================================================
-- Migration : 20261106010000_reliable_google_sheets_outbox.sql
-- Purpose   : Capture every sheet-relevant change transactionally and let a
--             scheduled server worker deliver/retry it without an open browser.
--
-- WHY THE OLD QUEUE DID NOT PREVENT DATA LOSS
--   It was populated only after an admin browser heard a Realtime event and
--   attempted a webhook call. With no admin tab open, no queue row was created.
--   The Settings "Retry queued" button only claimed rows; it never dispatched
--   them. A no-cors browser fallback also treated an unreadable response as a
--   success, so an actual failure could clear the queue.
--
--   This migration makes the queue a transactional outbox: the lead/note/photo
--   write and the queue write commit or roll back together. pg_cron invokes the
--   authenticated Edge worker every minute. The worker leases jobs, sends a
--   batched idempotent Apps Script request, and acknowledges each generation;
--   failures keep a job with bounded exponential backoff.
--
-- CAPTURED DATA
--   Leads (insert/update/delete), lead_notes and lead_photos (insert/update/
--   delete). The worker rereads the current lead plus all notes/photos when it
--   builds the sheet row, so several rapid edits coalesce into one current row.
--
-- INITIAL RECONCILIATION
--   Existing leads are enqueued once. This seeds the Sheet through the same
--   background worker as future changes. The admin full-sync control remains
--   available for a clean rebuild.
--
-- SECURITY
--   Trigger and worker RPCs are SECURITY DEFINER with a fixed search_path.
--   Clients cannot claim/complete outbox jobs directly; only admins can read
--   health or request processing, and the scheduled worker uses service_role.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

ALTER TABLE public.google_sheets_sync_queue
  ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS previous_statuses text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.google_sheets_sync_health
  ADD COLUMN IF NOT EXISTS reconcile_lock_token uuid,
  ADD COLUMN IF NOT EXISTS reconcile_lock_until timestamptz,
  ADD COLUMN IF NOT EXISTS reconcile_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconcile_clear_pending boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS google_sheets_sync_queue_claim_idx
  ON public.google_sheets_sync_queue (next_attempt_at, lease_until, enqueued_at);


-- -----------------------------------------------------------------------------
-- 1. Transactional enqueue function and source-table triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_google_sheets_sync(
  p_lead_id uuid,
  p_op text,
  p_job_id text,
  p_previous_status text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_lead_id IS NULL OR p_op IS NULL OR p_op NOT IN ('upsert', 'delete') THEN
    RETURN;
  END IF;

  INSERT INTO public.google_sheets_sync_queue AS q (
    lead_id, op, job_id, attempts, next_attempt_at, last_error,
    enqueued_at, generation, previous_statuses, lease_token, lease_until, updated_at
  )
  VALUES (
    p_lead_id, p_op, p_job_id, 0, now(), NULL,
    now(), 1, CASE WHEN p_previous_status IS NULL THEN '{}'::text[] ELSE ARRAY[p_previous_status] END,
    NULL, NULL, now()
  )
  ON CONFLICT (lead_id) DO UPDATE SET
    op              = EXCLUDED.op,
    job_id          = COALESCE(EXCLUDED.job_id, q.job_id),
    attempts        = 0,
    next_attempt_at = now(),
    last_error      = NULL,
    enqueued_at     = now(),
    generation      = q.generation + 1,
    previous_statuses = CASE
      WHEN p_previous_status IS NULL OR p_previous_status = ANY(q.previous_statuses)
        THEN q.previous_statuses
      ELSE array_append(q.previous_statuses, p_previous_status)
    END,
    lease_token     = NULL,
    lease_until     = NULL,
    updated_at      = now();
END;
$fn$;

REVOKE ALL ON FUNCTION public.enqueue_google_sheets_sync(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_sheets_enqueue_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_previous_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.enqueue_google_sheets_sync(OLD.id, 'delete', OLD.job_id, NULL);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_previous_status := OLD.status;
  END IF;
  PERFORM public.enqueue_google_sheets_sync(NEW.id, 'upsert', NEW.job_id, v_previous_status);
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.trg_sheets_enqueue_child()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_new_lead_id uuid;
  v_old_lead_id uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN v_new_lead_id := NEW.lead_id; END IF;
  IF TG_OP <> 'INSERT' THEN v_old_lead_id := OLD.lead_id; END IF;

  IF v_old_lead_id IS NOT NULL AND v_old_lead_id IS DISTINCT FROM v_new_lead_id THEN
    PERFORM public.enqueue_google_sheets_sync(v_old_lead_id, 'upsert', NULL, NULL);
  END IF;
  IF v_new_lead_id IS NOT NULL THEN
    PERFORM public.enqueue_google_sheets_sync(v_new_lead_id, 'upsert', NULL, NULL);
  ELSIF v_old_lead_id IS NOT NULL THEN
    PERFORM public.enqueue_google_sheets_sync(v_old_lead_id, 'upsert', NULL, NULL);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.trg_sheets_enqueue_lead() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_sheets_enqueue_child() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS leads_google_sheets_outbox ON public.leads;
CREATE TRIGGER leads_google_sheets_outbox
  AFTER INSERT OR UPDATE OR DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_sheets_enqueue_lead();

DROP TRIGGER IF EXISTS lead_notes_google_sheets_outbox ON public.lead_notes;
CREATE TRIGGER lead_notes_google_sheets_outbox
  AFTER INSERT OR UPDATE OR DELETE ON public.lead_notes
  FOR EACH ROW EXECUTE FUNCTION public.trg_sheets_enqueue_child();

DROP TRIGGER IF EXISTS lead_photos_google_sheets_outbox ON public.lead_photos;
CREATE TRIGGER lead_photos_google_sheets_outbox
  AFTER INSERT OR UPDATE OR DELETE ON public.lead_photos
  FOR EACH ROW EXECUTE FUNCTION public.trg_sheets_enqueue_child();

COMMENT ON TABLE public.google_sheets_sync_queue IS
  'Transactional outbox for every lead/note/photo change. Coalesced by lead id; '
  'generation prevents an older in-flight acknowledgement from clearing a newer change.';


-- -----------------------------------------------------------------------------
-- 2. Lease-based claim/ack/retry RPCs
--    The old claim function only incremented attempts and left next_attempt_at
--    due, so concurrent workers could claim the same job after the transaction
--    released its row lock. A lease now holds ownership across the HTTP call.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_sheets_sync_queue(integer);

CREATE FUNCTION public.claim_sheets_sync_queue(p_limit integer DEFAULT 25)
RETURNS TABLE (
  lead_id uuid,
  op text,
  job_id text,
  attempts integer,
  generation bigint,
  lease_token uuid,
  previous_statuses text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin or the sync worker may claim jobs'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.google_sheets_sync_health (id, status, updated_at)
  VALUES ('global', 'healthy', now())
  ON CONFLICT (id) DO NOTHING;
  -- Serialize the start of a worker batch against a full-reconcile lock.
  PERFORM 1 FROM public.google_sheets_sync_health WHERE id = 'global' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.google_sheets_sync_health h
              WHERE h.id = 'global'
                AND (h.reconcile_clear_pending OR h.reconcile_lock_until > now())) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT q.lead_id
      FROM public.google_sheets_sync_queue q
     WHERE q.next_attempt_at <= now()
       AND (q.lease_until IS NULL OR q.lease_until < now())
     ORDER BY q.next_attempt_at, q.enqueued_at
     LIMIT greatest(1, least(coalesce(p_limit, 25), 100))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.google_sheets_sync_queue q
     SET attempts = q.attempts + 1,
         lease_token = gen_random_uuid(),
         lease_until = now() + interval '3 minutes',
         updated_at = now()
    FROM due d
   WHERE q.lead_id = d.lead_id
  RETURNING q.lead_id, q.op, q.job_id, q.attempts, q.generation, q.lease_token, q.previous_statuses;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.finish_sheets_sync_job(
  p_lead_id uuid,
  p_generation bigint,
  p_lease_token uuid,
  p_success boolean,
  p_message text DEFAULT NULL,
  p_detail jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_rows integer;
  v_streak integer;
  v_attempts integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin or the sync worker may finish jobs'
      USING ERRCODE = '42501';
  END IF;

  IF p_success THEN
    DELETE FROM public.google_sheets_sync_queue q
     WHERE q.lead_id = p_lead_id
       AND q.generation = p_generation
       AND q.lease_token = p_lease_token;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN false; END IF;
    PERFORM public.record_sheets_sync_success(p_lead_id);
    RETURN true;
  END IF;

  UPDATE public.google_sheets_sync_queue q
     SET lease_token = NULL,
         lease_until = NULL,
         last_error = left(coalesce(p_message, 'Unknown delivery failure'), 500),
         next_attempt_at = now() + make_interval(
           secs => least(3600, power(2, least(greatest(q.attempts - 1, 0), 6)) * 60)::integer
         ),
         updated_at = now()
   WHERE q.lead_id = p_lead_id
     AND q.generation = p_generation
     AND q.lease_token = p_lease_token
  RETURNING q.attempts INTO v_attempts;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN false; END IF;

  INSERT INTO public.google_sheets_sync_errors (lead_id, action, message, detail)
  VALUES (p_lead_id, 'outbox_delivery', left(coalesce(p_message, 'Unknown delivery failure'), 1000), p_detail);

  INSERT INTO public.google_sheets_sync_health AS h (
    id, status, last_attempt_at, last_error_at, last_error_message,
    consecutive_failures, updated_at
  )
  VALUES ('global', 'degraded', now(), now(), left(coalesce(p_message, 'Unknown delivery failure'), 500), 1, now())
  ON CONFLICT (id) DO UPDATE SET
    status = CASE WHEN h.consecutive_failures + 1 >= 10 THEN 'down' ELSE 'degraded' END,
    last_attempt_at = now(),
    last_error_at = now(),
    last_error_message = left(coalesce(p_message, 'Unknown delivery failure'), 500),
    consecutive_failures = h.consecutive_failures + 1,
    updated_at = now()
  RETURNING consecutive_failures INTO v_streak;

  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.retry_sheets_sync_queue_now(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_rows integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin or the sync worker may retry jobs'
      USING ERRCODE = '42501';
  END IF;

  WITH selected AS (
    SELECT q.lead_id
      FROM public.google_sheets_sync_queue q
     ORDER BY q.enqueued_at
     LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.google_sheets_sync_queue q
     SET attempts = 0,
         next_attempt_at = now(),
         lease_token = NULL,
         lease_until = NULL,
         updated_at = now()
    FROM selected s
   WHERE q.lead_id = s.lead_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.begin_google_sheets_full_reconcile()
RETURNS TABLE (lock_token uuid, queued integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_token uuid := gen_random_uuid();
  v_queued integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  -- `syncing` is computed at read time; the stored CHECK constraint only
  -- permits persistent terminal/status values.
  INSERT INTO public.google_sheets_sync_health (id, status, updated_at)
  VALUES ('global', 'healthy', now())
  ON CONFLICT (id) DO NOTHING;
  PERFORM 1 FROM public.google_sheets_sync_health WHERE id = 'global' FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.google_sheets_sync_health
              WHERE id = 'global' AND (reconcile_active OR reconcile_lock_until > now())) THEN
    RAISE EXCEPTION 'A full Google Sheets rebuild is already running'
      USING ERRCODE = '55P03';
  END IF;
  IF EXISTS (SELECT 1 FROM public.google_sheets_sync_queue
              WHERE lease_until > now()) THEN
    RAISE EXCEPTION 'A delivery batch is in flight; retry the rebuild in a moment'
      USING ERRCODE = '55P03';
  END IF;

  UPDATE public.google_sheets_sync_health
     SET reconcile_lock_token = v_token,
         reconcile_lock_until = now() + interval '10 minutes',
         reconcile_active = true,
         reconcile_clear_pending = true,
         watermark_at = NULL,
         updated_at = now()
   WHERE id = 'global';

  -- The worker pauses under this lease. Once the Sheet has been cleared, every
  -- current lead is queued again. If the browser/Edge request stops midway, the
  -- lease expires and the normal worker still rebuilds every row.
  DELETE FROM public.google_sheets_sync_queue;
  INSERT INTO public.google_sheets_sync_queue (lead_id, op, job_id, attempts, next_attempt_at)
  SELECT l.id, 'upsert', l.job_id, 0, now()
    FROM public.leads l;
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN QUERY SELECT v_token, v_queued;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.finish_google_sheets_full_reconcile(p_lock_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_rows integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.google_sheets_sync_health
     SET reconcile_lock_token = NULL,
         reconcile_lock_until = NULL,
         reconcile_clear_pending = false,
         updated_at = now()
   WHERE id = 'global' AND reconcile_lock_token = p_lock_token;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_sheets_sync_queue(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_sheets_sync_job(uuid, bigint, uuid, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retry_sheets_sync_queue_now(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sheets_sync_queue(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_sheets_sync_job(uuid, bigint, uuid, boolean, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_sheets_sync_queue_now(integer) TO service_role;
REVOKE ALL ON FUNCTION public.begin_google_sheets_full_reconcile() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finish_google_sheets_full_reconcile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_google_sheets_full_reconcile() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_google_sheets_full_reconcile(uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. Restrict existing SECURITY DEFINER bookkeeping to admins/service_role
--    Authenticated admin calls are retained for the manual full-sync UI. Other
--    authenticated roles must not be able to erase or forge the backup health.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_sheets_sync_success(p_lead_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin or the sync worker may record sync success'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.google_sheets_sync_health AS h (
    id, status, last_attempt_at, last_success_at, last_error_message,
    consecutive_failures, synced_total, updated_at
  ) VALUES ('global', 'healthy', now(), now(), NULL, 0, 1, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'healthy',
    last_attempt_at = now(),
    last_success_at = now(),
    last_error_message = NULL,
    consecutive_failures = 0,
    synced_total = h.synced_total + 1,
    updated_at = now();

  IF p_lead_id IS NOT NULL THEN
    DELETE FROM public.google_sheets_sync_queue WHERE lead_id = p_lead_id;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.get_sheets_sync_queue_depth()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT count(*)::integer FROM public.google_sheets_sync_queue);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.record_sheets_sync_failure(
  p_message text,
  p_lead_id uuid DEFAULT NULL,
  p_action text DEFAULT 'sync',
  p_detail jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin or the sync worker may record sync failure'
      USING ERRCODE = '42501';
  END IF;

  IF p_lead_id IS NOT NULL THEN
    INSERT INTO public.google_sheets_sync_queue (
      lead_id, op, attempts, next_attempt_at, last_error, enqueued_at, generation
    ) VALUES (
      p_lead_id, CASE WHEN p_action = 'delete' THEN 'delete' ELSE 'upsert' END,
      1, now() + interval '1 minute', left(p_message, 500), now(), 1
    )
    ON CONFLICT (lead_id) DO UPDATE SET
      attempts = public.google_sheets_sync_queue.attempts + 1,
      last_error = left(EXCLUDED.last_error, 500),
      next_attempt_at = now() + make_interval(
        secs => least(3600, power(2, least(public.google_sheets_sync_queue.attempts, 6)) * 60)::integer
      ),
      lease_token = NULL,
      lease_until = NULL,
      updated_at = now();
  END IF;

  INSERT INTO public.google_sheets_sync_errors (lead_id, action, message, detail)
  VALUES (p_lead_id, p_action, left(p_message, 1000), p_detail);

  INSERT INTO public.google_sheets_sync_health AS h (
    id, status, last_attempt_at, last_error_at, last_error_message,
    consecutive_failures, updated_at
  ) VALUES (
    'global', 'degraded', now(), now(), left(p_message, 500), 1, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    status = CASE WHEN h.consecutive_failures + 1 >= 10 THEN 'down' ELSE 'degraded' END,
    last_attempt_at = now(),
    last_error_at = now(),
    last_error_message = left(EXCLUDED.last_error_message, 500),
    consecutive_failures = h.consecutive_failures + 1,
    updated_at = now();
END;
$fn$;

CREATE OR REPLACE FUNCTION public.prune_sheets_sync_errors(p_keep integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_deleted integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
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

-- Fix the never-reconciled age calculation: max(created_at) measured the newest
-- row, while a backup's age is the oldest row it still has not reconciled.
CREATE OR REPLACE FUNCTION public.sheets_sync_lag()
RETURNS TABLE (leads_behind bigint, behind_seconds integer, watermark_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_mark timestamptz;
  v_behind bigint := 0;
  v_seconds integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT h.watermark_at INTO v_mark
    FROM public.google_sheets_sync_health h WHERE h.id = 'global';
  IF v_mark IS NULL THEN
    SELECT count(*), extract(epoch FROM now() - min(l.created_at))::integer
      INTO v_behind, v_seconds
      FROM public.leads l;
  ELSE
    SELECT count(*), extract(epoch FROM now() - min(l.updated_at))::integer
      INTO v_behind, v_seconds
      FROM public.leads l
     WHERE l.updated_at > v_mark;
  END IF;
  IF v_behind = 0 THEN v_seconds := NULL; END IF;
  RETURN QUERY SELECT v_behind, v_seconds, v_mark;
END;
$fn$;

REVOKE ALL ON FUNCTION public.sheets_sync_lag() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sheets_sync_lag() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.raise_sheets_sync_stale_alert(
  p_stale_after_seconds integer DEFAULT 900,
  p_throttle_minutes integer DEFAULT 15
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_health record;
  v_sent integer := 0;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_health FROM public.get_sheets_sync_health(p_stale_after_seconds);
  IF v_health.status NOT IN ('degraded', 'down') THEN RETURN 0; END IF;
  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.user_id IN (SELECT user_id FROM public.user_roles WHERE role = 'admin')
       AND n.title = '[Alert] Google Sheets backup is behind'
       AND n.created_at > now() - make_interval(mins => greatest(coalesce(p_throttle_minutes, 15), 1))
  ) THEN RETURN 0; END IF;

  INSERT INTO public.notifications (user_id, title, message)
  SELECT ur.user_id,
         '[Alert] Google Sheets backup is behind',
          format(
            'Status %s. %s failed attempt(s) in a row; %s failed job(s) and %s total job(s) are queued. Last error: %s.',
            v_health.status, v_health.consecutive_failures, v_health.failed_jobs, v_health.queue_depth,
           coalesce(left(v_health.last_error_message, 200), 'none recorded')
         )
    FROM public.user_roles ur WHERE ur.role = 'admin';
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  RETURN v_sent;
END;
$fn$;

DROP FUNCTION IF EXISTS public.get_sheets_sync_health(integer);

CREATE FUNCTION public.get_sheets_sync_health(p_stale_after_seconds integer DEFAULT 900)
RETURNS TABLE (
  status text, last_attempt_at timestamptz, last_success_at timestamptz,
  last_error_at timestamptz, last_error_message text, consecutive_failures integer,
  synced_total bigint, queue_depth integer, seconds_since_success integer,
  recent_errors jsonb, leads_behind bigint, behind_seconds integer, watermark_at timestamptz,
  queue_oldest_at timestamptz, queue_oldest_seconds integer, failed_jobs integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.google_sheets_sync_health%ROWTYPE;
  v_lag record;
  v_depth integer;
  v_failed_jobs integer;
  v_queue_oldest timestamptz;
  v_queue_age integer;
  v_stale integer := greatest(coalesce(p_stale_after_seconds, 900), 60);
  v_since integer;
  v_status text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.google_sheets_sync_health WHERE id = 'global';
  IF NOT FOUND THEN
    SELECT count(*)::integer, min(q.enqueued_at),
           count(*) FILTER (WHERE q.last_error IS NOT NULL)::integer
      INTO v_depth, v_queue_oldest, v_failed_jobs
      FROM public.google_sheets_sync_queue q;
    v_queue_age := CASE WHEN v_queue_oldest IS NULL THEN NULL
                        ELSE extract(epoch FROM now() - v_queue_oldest)::integer END;
    RETURN QUERY SELECT CASE
        WHEN coalesce(v_failed_jobs, 0) > 0 THEN 'degraded'
        WHEN v_depth > 0 AND v_queue_age > v_stale THEN 'degraded'
        WHEN v_depth > 0 THEN 'syncing'
        ELSE 'idle'
      END,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::text,
      0, 0::bigint, v_depth, NULL::integer, '[]'::jsonb,
      (SELECT count(*) FROM public.leads), NULL::integer, NULL::timestamptz,
      v_queue_oldest, v_queue_age, coalesce(v_failed_jobs, 0);
    RETURN;
  END IF;

  SELECT * INTO v_lag FROM public.sheets_sync_lag();
  SELECT count(*)::integer, min(q.enqueued_at),
         count(*) FILTER (WHERE q.last_error IS NOT NULL)::integer
    INTO v_depth, v_queue_oldest, v_failed_jobs
    FROM public.google_sheets_sync_queue q;
  v_queue_age := CASE WHEN v_queue_oldest IS NULL THEN NULL
                      ELSE extract(epoch FROM now() - v_queue_oldest)::integer END;
  v_since := CASE WHEN v_row.last_success_at IS NULL THEN NULL
                  ELSE extract(epoch FROM now() - v_row.last_success_at)::integer END;

  v_status := CASE
    WHEN v_row.consecutive_failures >= 10 THEN 'down'
    WHEN v_row.consecutive_failures > 0 THEN 'degraded'
    WHEN v_failed_jobs > 0 THEN 'degraded'
    WHEN v_row.reconcile_active OR v_row.reconcile_clear_pending
      OR v_row.reconcile_lock_until > now() THEN 'syncing'
    WHEN v_depth > 0 AND v_queue_age > v_stale
      AND (v_since IS NULL OR v_since > v_stale) THEN 'degraded'
    WHEN v_depth > 0 THEN 'syncing'
    WHEN v_lag.leads_behind > 0 AND coalesce(v_lag.behind_seconds, v_stale + 1) > v_stale THEN 'degraded'
    WHEN v_lag.leads_behind > 0 THEN 'syncing'
    ELSE 'healthy'
  END;

  RETURN QUERY SELECT v_status, v_row.last_attempt_at, v_row.last_success_at,
    v_row.last_error_at, v_row.last_error_message, v_row.consecutive_failures,
    v_row.synced_total, v_depth, v_since,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'occurred_at', e.occurred_at, 'message', e.message,
      'action', e.action, 'lead_id', e.lead_id) ORDER BY e.occurred_at DESC)
      FROM (SELECT occurred_at, message, action, lead_id
              FROM public.google_sheets_sync_errors
             ORDER BY occurred_at DESC LIMIT 10) e), '[]'::jsonb),
    v_lag.leads_behind, v_lag.behind_seconds, v_row.watermark_at,
    v_queue_oldest, v_queue_age, v_failed_jobs;
END;
$fn$;

-- A previously successful single row is not proof of table currency. The
-- scheduled worker advances this watermark only after it observes an empty
-- outbox, and this function is now admin/service_role only.
CREATE OR REPLACE FUNCTION public.advance_sheets_sync_watermark()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_mark timestamptz := clock_timestamp();
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin or the sync worker may advance the watermark'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.google_sheets_sync_queue) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.google_sheets_sync_health h
              WHERE h.id = 'global'
                AND (h.reconcile_clear_pending OR h.reconcile_lock_until > now())) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.google_sheets_sync_health AS h (
    id, status, last_attempt_at, last_success_at, watermark_at,
    last_error_message, consecutive_failures, updated_at
  ) VALUES ('global', 'healthy', v_mark, v_mark, v_mark, NULL, 0, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'healthy',
    watermark_at = GREATEST(h.watermark_at, EXCLUDED.watermark_at),
    last_success_at = EXCLUDED.last_success_at,
    last_attempt_at = EXCLUDED.last_attempt_at,
    last_error_message = NULL,
    consecutive_failures = 0,
    reconcile_active = false,
    reconcile_clear_pending = false,
    reconcile_lock_token = NULL,
    reconcile_lock_until = NULL,
    updated_at = now();
  RETURN v_mark;
END;
$fn$;

-- Health/read RPCs remain authenticated for the Admin Settings UI; state
-- mutation RPCs above are only callable by the Edge worker.
REVOKE ALL ON FUNCTION public.get_sheets_sync_health(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_sheets_sync_queue_depth() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.advance_sheets_sync_watermark() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_sheets_sync_success(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prune_sheets_sync_errors(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_queue_depth() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.advance_sheets_sync_watermark() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_sheets_sync_success(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prune_sheets_sync_errors(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 4. Non-browser worker schedule
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cron_google_sheets_sync_worker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_service_key text;
  v_cron_secret text;
BEGIN
  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
  SELECT value->>0 INTO v_cron_secret
    FROM public.quo_ai_settings WHERE key = 'cron_secret';

  IF coalesce(v_service_key, '') = '' THEN
    RAISE WARNING 'Google Sheets worker not invoked: service_role_key is missing from Vault';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'http://kong:8000/functions/v1/google-sheets-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_service_key,
      'Authorization', 'Bearer ' || v_service_key,
      'x-cron-secret', coalesce(v_cron_secret, '')
    ),
    body := jsonb_build_object('action', 'process_queue', 'limit', 25)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.cron_google_sheets_sync_worker() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'google-sheets-outbox-worker';
    PERFORM cron.schedule(
      'google-sheets-outbox-worker',
      '*/3 * * * *',
      'SELECT public.cron_google_sheets_sync_worker()'
    );
  ELSE
    RAISE WARNING 'pg_cron is unavailable; Google Sheets changes will queue but not auto-deliver.';
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 5. Seed the outbox with the current CRM snapshot. This starts the first
--    background catch-up after deployment without requiring an open admin tab.
-- -----------------------------------------------------------------------------
INSERT INTO public.google_sheets_sync_queue (lead_id, op, job_id, attempts, next_attempt_at)
SELECT l.id, 'upsert', l.job_id, 0, now()
  FROM public.leads l
ON CONFLICT (lead_id) DO NOTHING;


-- =============================================================================
-- ROLLBACK - run manually to stop the worker and remove transactional capture.
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'google-sheets-outbox-worker';
--   DROP TRIGGER IF EXISTS leads_google_sheets_outbox ON public.leads;
--   DROP TRIGGER IF EXISTS lead_notes_google_sheets_outbox ON public.lead_notes;
--   DROP TRIGGER IF EXISTS lead_photos_google_sheets_outbox ON public.lead_photos;
--   DROP FUNCTION IF EXISTS public.trg_sheets_enqueue_lead();
--   DROP FUNCTION IF EXISTS public.trg_sheets_enqueue_child();
--   DROP FUNCTION IF EXISTS public.enqueue_google_sheets_sync(uuid,text,text,text);
--   DROP FUNCTION IF EXISTS public.finish_sheets_sync_job(uuid,bigint,uuid,boolean,text,jsonb);
--   DROP FUNCTION IF EXISTS public.retry_sheets_sync_queue_now(integer);
--   DROP FUNCTION IF EXISTS public.cron_google_sheets_sync_worker();
--   -- Do not drop the existing health tables; prior retry history is useful.
-- =============================================================================
