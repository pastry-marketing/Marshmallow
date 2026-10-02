-- =============================================================================
-- Migration : 20261102000100_revoke_sheets_sync_functions_from_public.sql
-- Purpose   : Close an anon-reachable path created by the sync health layer.
--
-- THE PROBLEM
--   The functions in 20261102000000 are SECURITY DEFINER, which means they run
--   as their owner and therefore bypass the row level security policies on
--   google_sheets_sync_health, _errors and _queue.
--
--   PostgreSQL grants EXECUTE on a new function to PUBLIC by default. That
--   migration granted EXECUTE to authenticated but never revoked it from
--   PUBLIC, so anon could call every one of them. The RLS policies added in
--   the same migration were therefore not the access control people would
--   reasonably assume they were.
--
--   Verified against the live database before writing this file:
--
--     fn                                        auth   anon
--     claim_sheets_sync_queue(integer)          true   true
--     get_sheets_sync_health(integer)           true   true
--     get_sheets_sync_queue_depth()             true   true
--     prune_sheets_sync_errors(integer)         true   true
--     raise_sheets_sync_stale_alert(int,int)    true   true
--     record_sheets_sync_failure(...)           true   true
--     record_sheets_sync_success(uuid)          true   true
--
--   What that allowed an unauthenticated caller to do:
--
--     get_sheets_sync_health     read sync status and the last ten error
--                                messages, which include lead identifiers
--     claim_sheets_sync_queue    read queued lead identifiers and increment
--                                their attempt counters
--     record_sheets_sync_failure push arbitrary lead ids onto the retry queue,
--                                write to the error log, and drive the status
--                                to degraded or down - so an anonymous caller
--                                could make the sync look broken
--     record_sheets_sync_success clear the failure streak and mark it healthy,
--                                hiding a genuine outage
--     raise_sheets_sync_stale_alert  insert a notification row for every admin
--                                - anonymous notification spam
--
-- THE FIX
--   Revoke from PUBLIC first, then grant only what each role needs. Revoking
--   after granting is fine here because authenticated already holds its grant
--   directly, but the order is kept explicit so the intent is readable.
--
--   service_role is granted as well because the cron path that eventually
--   drains the queue runs as the service role, not as a browser session.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Revoke the default PUBLIC grant. This is the step that was missing.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_sheets_sync_success(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_sheets_sync_queue(integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_sheets_sync_queue_depth()
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prune_sheets_sync_errors(integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_sheets_sync_health(integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer)
  FROM PUBLIC, anon;


-- -----------------------------------------------------------------------------
-- Re-grant only what is required.
-- -----------------------------------------------------------------------------
-- Browser session (an authenticated admin) - drives the UI and records outcomes.
GRANT EXECUTE ON FUNCTION public.record_sheets_sync_success(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sheets_sync_queue(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_queue_depth() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prune_sheets_sync_errors(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) TO authenticated;

-- Service role - the server-side cron path that will drain the queue.
GRANT EXECUTE ON FUNCTION public.record_sheets_sync_success(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sheets_sync_queue(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_queue_depth() TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_sheets_sync_errors(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) TO service_role;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   GRANT EXECUTE ON FUNCTION public.record_sheets_sync_success(uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.record_sheets_sync_failure(text, uuid, text, jsonb) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.claim_sheets_sync_queue(integer) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.get_sheets_sync_queue_depth() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.prune_sheets_sync_errors(integer) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.raise_sheets_sync_stale_alert(integer, integer) TO PUBLIC;
--
-- Rolling back restores the anon-reachable path described above. Do not do this
-- unless the access model has genuinely changed.
-- =============================================================================