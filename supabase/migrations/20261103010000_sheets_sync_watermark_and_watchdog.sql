-- =============================================================================
-- Migration : 20261103010000_sheets_sync_watermark_and_watchdog.sql
-- Purpose   : Make "is my backup current?" answerable from the database, and
--             have it checked on a schedule with no browser open.
--
-- WHAT WAS WRONG
--
--   The staleness rule was wall-clock: if nothing had synced for fifteen
--   minutes the status degraded. For a backup that is simply wrong. Twenty
--   minutes with nobody editing a lead means the sheet is perfectly current,
--   and that state raised an alert every time the office went quiet.
--
--   Worse, last_success_at was written by every single-lead upsert. Lead A
--   syncing at 10:00 set last_success_at to 10:00 even if lead B had been
--   unsynced since 09:00, so B looked caught up. A single successful write
--   was evidence about the whole table, which it is not.
--
-- THE MODEL THIS REPLACES IT WITH
--
--   A watermark: the point up to which the sheet is known to be complete.
--   Single-lead upserts deliberately do NOT move it, because one lead
--   syncing says nothing about the other three thousand. Only a full or
--   delta reconciliation advances it.
--
--   Everything else is derived from that watermark:
--
--     leads_behind   how many leads changed after it, i.e. how many records
--                    the backup is missing right now
--     behind_seconds how old the oldest missing change is, i.e. how stale
--                    the backup is in real terms
--
--   Status then depends on records rather than on the clock, so an idle
--   system reads healthy and a genuinely broken one reads down.
--
-- THE WATCHDOG
--
--   pg_cron calls raise_sheets_sync_stale_alert every five minutes, so the
--   alert is written to the notifications table with every browser closed.
--   Previously only an open admin session could raise it, which is the wrong
--   way round: the alert matters most when nobody is looking.
--
-- PERMISSIONS
--   revoke_sheets_sync_public stays in force. The watchdog calls a SECURITY
--   DEFINER function from inside the database, so it needs no client grant.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Watermark column
--    NULL means the sheet has never been reconciled, which is treated as
--    everything being behind rather than nothing.
-- -----------------------------------------------------------------------------
ALTER TABLE public.google_sheets_sync_health
  ADD COLUMN IF NOT EXISTS watermark_at timestamptz;

COMMENT ON COLUMN public.google_sheets_sync_health.watermark_at IS
  'The point up to which the sheet is known to be complete. Advanced only by a '
  'full or delta reconciliation, never by a single-lead upsert.';


-- -----------------------------------------------------------------------------
-- 2. Advance the watermark
--    Called after a full or delta sync completes. Marks every lead changed at
--    or before now() as covered.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_sheets_sync_watermark()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_mark timestamptz := now();
BEGIN
  INSERT INTO public.google_sheets_sync_health AS h (
    id, status, last_attempt_at, last_success_at, watermark_at,
    last_error_message, consecutive_failures, updated_at
  )
  VALUES ('global', 'healthy', v_mark, v_mark, v_mark, NULL, 0, v_mark)
  ON CONFLICT (id) DO UPDATE SET
    watermark_at    = GREATEST(h.watermark_at, EXCLUDED.watermark_at),
    last_success_at = EXCLUDED.last_success_at,
    last_attempt_at = EXCLUDED.last_attempt_at,
    updated_at      = now();

  RETURN v_mark;
END;
$fn$;

COMMENT ON FUNCTION public.advance_sheets_sync_watermark() IS
  'Marks the sheet complete up to now. Call after a full or delta sync, never '
  'after a single-lead upsert.';


-- -----------------------------------------------------------------------------
-- 3. How far behind is the sheet, in records
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sheets_sync_lag()
RETURNS TABLE (
  leads_behind   bigint,
  behind_seconds integer,
  watermark_at   timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_mark   timestamptz;
  v_behind bigint := 0;
  v_seconds integer := NULL;
BEGIN
  SELECT h.watermark_at INTO v_mark
    FROM public.google_sheets_sync_health h
   WHERE h.id = 'global';

  -- Never reconciled: everything counts as missing, which is the honest answer.
  IF v_mark IS NULL THEN
    SELECT count(*) INTO v_behind FROM public.leads;
    IF v_behind > 0 THEN
      SELECT extract(epoch FROM (now() - max(created_at)))::integer
        INTO v_seconds
        FROM public.leads;
    END IF;
    RETURN QUERY SELECT v_behind, v_seconds, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT count(*) INTO v_behind
    FROM public.leads l
   WHERE l.updated_at > v_mark;

  IF v_behind > 0 THEN
    SELECT extract(epoch FROM (now() - min(l.updated_at)))::integer
      INTO v_seconds
      FROM public.leads l
     WHERE l.updated_at > v_mark;
  END IF;

  RETURN QUERY SELECT v_behind, v_seconds, v_mark;
END;
$fn$;

COMMENT ON FUNCTION public.sheets_sync_lag() IS
  'How many leads changed after the watermark, and how old the oldest of them '
  'is. Zero means the backup is current regardless of how long ago it ran.';


-- -----------------------------------------------------------------------------
-- 4. Health now reports records behind, not just a clock reading
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sheets_sync_health(
  p_stale_after_seconds integer DEFAULT 900
)
RETURNS TABLE (
  status                text,
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_error_at         timestamptz,
  last_error_message    text,
  consecutive_failures  integer,
  synced_total          bigint,
  queue_depth           integer,
  seconds_since_success integer,
  recent_errors         jsonb,
  leads_behind          bigint,
  behind_seconds        integer,
  watermark_at          timestamptz
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
  v_lag    record;
BEGIN
  SELECT * INTO v_row FROM public.google_sheets_sync_health WHERE id = 'global';

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'idle', NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
                        NULL::text, 0, 0::bigint, 0, NULL::integer, '[]'::jsonb,
                        0::bigint, NULL::integer, NULL::timestamptz;
    RETURN;
  END IF;

  v_since := CASE
    WHEN v_row.last_success_at IS NULL THEN NULL
    ELSE extract(epoch FROM (now() - v_row.last_success_at))::integer
  END;

  SELECT * INTO v_lag FROM public.sheets_sync_lag();

  -- A recorded failure streak is authoritative.
  -- Otherwise the verdict is about the data, not the clock: a system with
  -- leads outstanding is behind whether it is one second or one hour old,
  -- and an idle system with nothing outstanding is healthy however long it
  -- has been quiet.
  v_status := CASE
    WHEN v_row.consecutive_failures >= 10 THEN 'down'
    WHEN v_row.consecutive_failures > 0 AND v_lag.leads_behind > 0 THEN 'degraded'
    WHEN v_lag.leads_behind > 0 AND v_lag.behind_seconds > v_stale THEN 'degraded'
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
    ), '[]'::jsonb),
    v_lag.leads_behind,
    v_lag.behind_seconds,
    v_row.watermark_at;
END;
$fn$;


-- -----------------------------------------------------------------------------
-- 5. Alert wording that says how much backup is missing
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
  v_health record;
  v_sent   integer := 0;
BEGIN
  SELECT * INTO v_health FROM public.get_sheets_sync_health(p_stale_after_seconds);

  IF v_health.status NOT IN ('degraded', 'down') THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.user_id IN (SELECT user_id FROM public.user_roles WHERE role = 'admin')
       AND n.title = '[Alert] Google Sheets backup is behind'
       AND n.created_at > now() - make_interval(mins => greatest(coalesce(p_throttle_minutes, 15), 1))
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.notifications (user_id, title, message)
  SELECT ur.user_id,
         '[Alert] Google Sheets backup is behind',
         CASE
           WHEN v_health.leads_behind > 0
             THEN format(
                   'The sheet is missing %s lead(s), the oldest for %s. %s sync failure(s) in a row. Last error: %s.',
                   v_health.leads_behind,
                   CASE WHEN v_health.behind_seconds IS NULL THEN 'unknown'
                        WHEN v_health.behind_seconds < 60 THEN v_health.behind_seconds || ' seconds'
                        WHEN v_health.behind_seconds < 3600 THEN floor(v_health.behind_seconds / 60) || ' minutes'
                        ELSE floor(v_health.behind_seconds / 3600) || ' hours' END,
                   v_health.consecutive_failures,
                   coalesce(left(v_health.last_error_message, 160), 'none recorded')
                 )
           ELSE format(
                   'Sync is not keeping up: %s failed attempt(s) in a row and %s lead(s) are queued for retry. Last error: %s.',
                   v_health.consecutive_failures,
                   v_health.queue_depth,
                   coalesce(left(v_health.last_error_message, 160), 'none recorded')
                 )
         END
    FROM public.user_roles ur
   WHERE ur.role = 'admin';

  GET DIAGNOSTICS v_sent = ROW_COUNT;
  RETURN v_sent;
END;
$fn$;


-- -----------------------------------------------------------------------------
-- 6. The watchdog
--    Runs with every browser closed, which is the whole point of putting the
--    check in the database rather than in the UI.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; the watchdog was not scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sheets-sync-watchdog';

  PERFORM cron.schedule(
    'sheets-sync-watchdog',
    '*/5 * * * *',
    $job$SELECT public.raise_sheets_sync_stale_alert(900, 15);$job$
  );

  RAISE NOTICE 'scheduled sheets-sync-watchdog every 5 minutes';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'could not schedule the watchdog: %', SQLERRM;
END $$;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sheets-sync-watchdog';
--   DROP FUNCTION IF EXISTS public.sheets_sync_lag();
--   DROP FUNCTION IF EXISTS public.advance_sheets_sync_watermark();
--   DROP FUNCTION IF EXISTS public.raise_sheets_sync_stale_alert(integer, integer);
--   DROP FUNCTION IF EXISTS public.get_sheets_sync_health(integer);
--   ALTER TABLE public.google_sheets_sync_health DROP COLUMN IF EXISTS watermark_at;
--
-- Rolling back returns staleness to a wall-clock rule, which alerts on an idle
-- system and misses leads outstanding for less than the threshold.
-- =============================================================================