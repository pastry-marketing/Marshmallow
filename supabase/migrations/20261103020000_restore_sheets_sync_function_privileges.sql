-- =============================================================================
-- Migration : 20261103020000_restore_sheets_sync_function_privileges.sql
-- Purpose   : Close an anon-reachable path that a DROP+CREATE reopened.
--
-- THE BUG
--   20261102000100 revoked these functions from PUBLIC because they are
--   SECURITY DEFINER, which means they run as their owner and bypass the row
--   level security policies on the tables underneath. RLS on a table is not
--   access control for a SECURITY DEFINER function that writes to it.
--
--   20261103010000 then had to DROP public.get_sheets_sync_health and CREATE
--   it again, because CREATE OR REPLACE cannot change a function's return
--   type. A plain CREATE grants EXECUTE to PUBLIC by default, so dropping the
--   function silently discarded the revoke and handed the privilege back.
--
--   It also introduced public.advance_sheets_sync_watermark with no revoke at
--   all, being brand new.
--
--   Confirmed against the live database before writing this file:
--
--     fn                                        security_definer  anon
--     advance_sheets_sync_watermark()           true               TRUE
--     get_sheets_sync_health(integer)            true               TRUE
--     claim_sheets_sync_queue(integer)           true               false
--     get_sheets_sync_queue_depth()              true               false
--     prune_sheets_sync_errors(integer)          true               false
--     raise_sheets_sync_stale_alert(int,int)     true               false
--     record_sheets_sync_failure(...)            true               false
--     record_sheets_sync_success(uuid)           true               false
--
--   WHAT ANONYMOUS CALLER COULD DO
--
--     advance_sheets_sync_watermark   Moves the watermark to now(), after
--       which every lead counts as synced. The panel reads "Backup current"
--       and the watchdog stops alerting, while the sheet is in fact empty or
--       stale. This defeats the entire purpose of the alarm: it lets a caller
--       silence the alarm about the backup without syncing anything.
--
--     get_sheets_sync_health          Reads sync status and the last ten
--       errors, which carry lead identifiers.
--
--   Neither writes to the leads table. The worst outcome is a backup alarm
--   being silenced, not data being changed or destroyed.
--
-- THE LESSON, RECORDED HERE SO IT IS NOT REPEATED
--   Any future migration that DROPs and recreates one of these functions
--   resets its grants to the Postgres default and reopens this. Harness 70
--   now asserts EXECUTE for every sync function on every run, including the
--   two added here, so a regression fails the harness rather than waiting to
--   be found by inspection.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Revoke the default PUBLIC grant. Must come before the re-grants.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_sheets_sync_health(integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.advance_sheets_sync_watermark()
  FROM PUBLIC, anon;


-- -----------------------------------------------------------------------------
-- Re-grant to the two roles that legitimately need them.
--   authenticated drives the Settings UI and reports outcomes.
--   service_role is the server-side cron path that will drain the queue.
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_sheets_sync_watermark() TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_sheets_sync_watermark() TO service_role;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   GRANT EXECUTE ON FUNCTION public.get_sheets_sync_health(integer) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.advance_sheets_sync_watermark() TO PUBLIC;
--
-- Rolling back lets an anonymous caller move the watermark, which reports the
-- backup as current regardless of whether it is. Do not do this.
-- =============================================================================