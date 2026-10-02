-- =============================================================================
-- Migration : 20261103000000_sheets_sync_trigger_sources.sql
-- Purpose   : Make note and photo changes reach the Google Sheets mirror.
--
-- THE PROBLEM
--   The sheet row is assembled from three tables: leads, lead_notes and
--   lead_photos. The CS Notes, Processor Notes, Opr Notes and Pictures
--   columns all come from the latter two. Sync listened only to "leads".
--
--   So a note added through the CRM wrote to lead_notes, no leads row was
--   touched, no realtime event for the mirror fired, and the sheet kept the
--   old note text. Confirmed against live data: a note edit left leads
--   untouched in the same window.
--
--   Photos were worse: lead_photos was not in the realtime publication at
--   all, so no event could ever be delivered.
--
-- WHAT THIS DOES
--   1. Publishes lead_photos so its changes are visible.
--   2. Sets REPLICA IDENTITY FULL on the two child tables.
--
-- WHY REPLICA IDENTITY FULL MATTERS
--   On a DELETE, Postgres sends only the primary key unless replica identity
--   is FULL. For these tables that means no lead_id, so a deleted note or
--   photo cannot be attributed to a lead and the mirror cannot be corrected.
--   With FULL the old row is included and the change is synced like any other.
--
--   This was also already wrong on leads. Migration
--   20260908120000_leads_replica_identity_full.sql set it, but the live table
--   reads relreplident = 'd', so that migration did not take effect. It is
--   corrected here for consistency even though the mirror does not currently
--   depend on it: the Apps Script derives a lead's current status by scanning
--   the row it was sent rather than trusting a previous value, so the missing
--   previous-status data has not corrupted the sheet.
--
-- COST
--   REPLICA IDENTITY FULL increases WAL volume for these tables because the
--   old row is written on every update. Both are small, low-churn tables, so
--   this is not a concern here. It is not applied to leads for that reason:
--   leads is the largest table in the database and nothing currently needs it.
--
-- PERMISSIONS
--   No policy changes. This only affects what Postgres publishes to Realtime.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Publish lead_photos so its changes are delivered at all
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'lead_photos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_photos;
    RAISE NOTICE 'added lead_photos to supabase_realtime';
  ELSE
    RAISE NOTICE 'lead_photos already published';
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 2. Carry the lead id on deletes for the two child tables
-- -----------------------------------------------------------------------------
ALTER TABLE public.lead_notes  REPLICA IDENTITY FULL;
ALTER TABLE public.lead_photos REPLICA IDENTITY FULL;


-- -----------------------------------------------------------------------------
-- 3. Correct leads, which a previous migration claimed to do
--    Without it a leads DELETE event carries only the primary key, so the
--    mirror loses the job id it uses to remove the row from the sheet.
-- -----------------------------------------------------------------------------
ALTER TABLE public.leads REPLICA IDENTITY FULL;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   ALTER TABLE public.leads       REPLICA IDENTITY DEFAULT;
--   ALTER TABLE public.lead_notes  REPLICA IDENTITY DEFAULT;
--   ALTER TABLE public.lead_photos REPLICA IDENTITY DEFAULT;
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.lead_photos;
--
-- Rolling back stops photo changes from being delivered, and stops deletes on
-- notes and photos from naming the lead they belonged to. No row is modified.
-- =============================================================================