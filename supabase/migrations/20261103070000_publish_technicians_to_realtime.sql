-- =============================================================================
-- Migration : 20261103070000_publish_technicians_to_realtime.sql
-- Purpose   : Publish the technicians table so a Good Tech or active change
--             reaches a Technicians page that is already open elsewhere.
--
-- WHY
--   The approval flow works in one tab and is invisible in another. An admin
--   approves on Tech Approvals, the row is written, and a processor already
--   looking at Technicians keeps seeing the old value until the 30 second
--   staleTime lapses or they navigate. Reads as a failed approval.
--
--   Verified against the live publication before writing this: technicians was
--   absent entirely.
--
--     pg_publication_tables for supabase_realtime:
--       leads
--       technician_change_requests
--       -- technicians missing
--
--   Invalidating the query from the page that performed the write fixes the
--   same tab only. It cannot reach a second tab, a second browser, or a
--   colleague's session, which is the normal way this is noticed: the person
--   who approved is not the person watching the list.
--
-- WHAT IT COSTS
--   Realtime delivers every insert, update and delete on technicians to
--   subscribed clients. This is a small table with low churn, changed by an
--   admin action or a request approval rather than by routine lead work. The
--   payload is the row as the subscription is configured, so the client
--   invalidates on the event rather than patching from it.
--
--   The client subscription reads no column values, so this does not widen
--   what any role can select. Table read access is still governed by the
--   existing policies on technicians.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'technicians'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.technicians;
    RAISE NOTICE 'added technicians to supabase_realtime';
  ELSE
    RAISE NOTICE 'technicians already published';
  END IF;
END $$;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.technicians;
--
-- Rolling back stops Good Tech and active changes reaching an open Technicians
-- page, so they only appear after a reload or a navigation.
-- =============================================================================