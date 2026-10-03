-- =============================================================================
-- Migration : 20261103040000_revoke_sheets_sync_lag_from_public.sql
-- Purpose   : Close the third anon-reachable sync function, which the previous
--             revoke migration reported but did not include.
--
-- THE OMISSION
--   20261103020000 was written after identifying three functions reachable by
--   anon, but only revoked two of them. sheets_sync_lag was named in the
--   header comment of that file and then left out of its statement list, so the
--   hole it closes was documented rather than closed.
--
--   Caught by querying the live grants afterwards rather than trusting the
--   migration had done what its comment claimed.
--
-- WHAT IT EXPOSES
--
--   sheets_sync_lag returns how many leads changed after the sync watermark,
--   how old the oldest of them is, and the watermark itself. Read only, so
--   this is an information leak rather than a way to alter data: it tells an
--   unauthenticated caller how far behind the backup is and how much business
--   activity has happened, on a schedule, for free.
--
--   It is SECURITY DEFINER and stable, so it reveals the same figures whether
--   or not the caller holds any role at all.
--
-- WHY IT MATTERS EVEN THOUGH IT ONLY READS
--
--   The neighbouring revoke exists because a SECURITY DEFINER function
--   bypasses the row level security on the tables underneath. That reasoning
--   does not stop applying just because this particular function happens to be
--   read only, and leaving one straggler reachable means the next person to
--   read the grant list has to work out whether this one was deliberate.
--
-- ALSO REVOKED
--
--   set_technician_change_request_updated_at, added by
--   20261103030000. It is NOT security definer, so it cannot bypass anything,
--   and the table policy in front of it still applies. Revoked for hygiene only:
--   an unauthenticated caller should not be able to invoke any function in this
--   feature's surface.
--
-- NOTE FOR ANY FUTURE MIGRATION TOUCHING THESE FUNCTIONS
--
--   A DROP followed by CREATE resets grants to the Postgres default of EXECUTE
--   to PUBLIC, silently discarding a revoke. That has already happened once
--   here, when get_sheets_sync_health had to be recreated to change its return
--   type. Harness 70 now matches proname LIKE '%sheets_sync%' for its privilege
--   checks rather than naming functions, precisely so a new or recreated one
--   cannot slip through unasserted.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Revoke the default PUBLIC grant.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.sheets_sync_lag() FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.set_technician_change_request_updated_at() FROM PUBLIC, anon;


-- -----------------------------------------------------------------------------
-- Re-grant to the roles that legitimately call them.
--   service_role is included because the server-side cron path reads lag when
--   deciding whether the backup is behind.
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.sheets_sync_lag() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sheets_sync_lag() TO service_role;

GRANT EXECUTE ON FUNCTION public.set_technician_change_request_updated_at() TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   GRANT EXECUTE ON FUNCTION public.sheets_sync_lag() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.set_technician_change_request_updated_at() TO PUBLIC;
--
-- Rolling back returns an unauthenticated read of how far behind the CRM backup
-- is. Do not do this.
-- =============================================================================