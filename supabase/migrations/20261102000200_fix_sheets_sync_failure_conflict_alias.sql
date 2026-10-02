-- =============================================================================
-- Migration : 20261102000200_fix_sheets_sync_failure_conflict_alias.sql
-- Purpose   : Repair record_sheets_sync_failure, which could not run at all.
--
-- THE BUG
--   The function inserts into google_sheets_sync_health with an alias:
--
--     INSERT INTO public.google_sheets_sync_health AS h (...)
--     ...
--     ON CONFLICT (id) DO UPDATE SET
--       consecutive_failures = public.google_sheets_sync_health.consecutive_failures + 1,
--
--   Supplying AS h makes h the only qualifier for the target row. The original
--   table name is no longer accepted inside the SET expression, so every call
--   raised:
--
--     invalid reference to FROM-clause entry for table "google_sheets_sync_health"
--
--   The reference is now h.consecutive_failures.
--
-- WHY IT COMPILED
--   plpgsql does not resolve SQL statement bodies at CREATE time, so this
--   shipped through a clean apply. It only failed on first execution.
--
--   The sibling function record_sheets_sync_success does the same insert and
--   already used the alias correctly, which is why it worked and this one did
--   not. The two were written moments apart and the same line differs between
--   them.
--
-- THE IMPACT, HONESTLY
--   Until this migration runs, the entire failure-reporting path is inert. No
--   failure was recorded, no lead was queued, no status degraded and no alert
--   could ever fire. Any health status shown before now came only from
--   record_sheets_sync_success. The harness caught it on first execution:
--   checks 4 to 9 and 12 all failed on this error.
--
--   Note the queue upsert further up the function was already correct, because
--   that INSERT has no alias and so accepts the table name. Only the aliased
--   insert was wrong.
--
-- PRIVILEGES
--   CREATE OR REPLACE preserves the existing ACL, so the PUBLIC revoke from
--   20261102000100 stays in force. Nothing is re-granted here.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================

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
    -- No alias on this INSERT, so the table name is the correct qualifier.
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
    -- Aliased insert: h is the only valid qualifier here.
    status               = CASE
                             WHEN h.consecutive_failures + 1 >= 10
                               THEN 'down'
                             ELSE 'degraded'
                           END,
    last_attempt_at      = now(),
    last_error_at        = now(),
    last_error_message   = left(EXCLUDED.last_error_message, 500),
    consecutive_failures = h.consecutive_failures + 1,
    updated_at           = now()
  RETURNING consecutive_failures INTO v_streak;
END;
$fn$;

COMMENT ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) IS
  'Records a failed dispatch, logs it, and queues the lead for retry. Three '
  'consecutive turns degraded, ten turns down.';


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP FUNCTION IF EXISTS public.record_sheets_sync_failure(text, uuid, text, jsonb);
--
-- Rolling back returns the function to a state that raises on every call. Do
-- not do this: silent sync failure is the problem this file exists to remove.
-- =============================================================================