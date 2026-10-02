-- =============================================================================
-- Harness : 70_google_sheets_sync_health.sql
-- Purpose : Prove the sync health layer actually behaves, rather than assuming
--           it does because it compiled.
--
-- WHY THIS EXISTS
--   Two defects in this project shipped through syntax-valid SQL: a missing
--   column alias (42703) and a mistyped reference. Both compiled. Both were
--   caught only by executing the query and reading the result. So this
--   harness asserts behaviour, not existence.
--
-- HOW TO RUN
--   Apply 20261102000000_google_sheets_sync_health.sql first, then run this in
--   the Supabase SQL editor.
--
--   It returns one row per check with an OK column. A check that fails is
--   caught and recorded rather than raised, so one failure never hides the
--   checks after it.
--
--   Everything is rolled back at the end, so live data is untouched.
--
--   Expected: every OK is true. Read DETAIL for the expected and actual values.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _results (
  seq    integer PRIMARY KEY,
  name   text NOT NULL,
  ok     boolean NOT NULL,
  detail text
) ON COMMIT DROP;


-- -----------------------------------------------------------------------------
-- 01  Objects exist
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  -- to_regclass resolves relations only. Functions need to_regprocedure with
  -- their full argument signature, otherwise every function reads as missing
  -- and this check fails for the wrong reason.
  SELECT string_agg(obj, ', ' ORDER BY obj) INTO v_missing
    FROM unnest(ARRAY[
      'public.google_sheets_sync_health',
      'public.google_sheets_sync_errors',
      'public.google_sheets_sync_queue',
      'public.record_sheets_sync_success(uuid)',
      'public.record_sheets_sync_failure(text,uuid,text,jsonb)',
      'public.claim_sheets_sync_queue(integer)',
      'public.get_sheets_sync_health(integer)',
      'public.get_sheets_sync_queue_depth()',
      'public.prune_sheets_sync_errors(integer)',
      'public.raise_sheets_sync_stale_alert(integer,integer)'
    ]) AS obj
   WHERE to_regclass(obj) IS NULL
     AND to_regprocedure(obj) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing: % - has the migration been applied?', v_missing;
  END IF;

  INSERT INTO _results VALUES (1, 'objects exist', true, 'all 10 present');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (1, 'objects exist', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 02  leads.updated_at is maintained by the database
--      The client used to set this by hand, so any update path that forgot it
--      left the row looking untouched. Delta sync depends on it being right.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_id     uuid;
  v_before timestamptz;
  v_after  timestamptz;
BEGIN
  SELECT id, updated_at INTO v_id, v_before
    FROM public.leads WHERE id IS NOT NULL LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO _results VALUES (2, 'leads.updated_at maintained', true, 'skipped, no leads');
    RETURN;
  END IF;

  -- An UPDATE that never mentions updated_at.
  UPDATE public.leads SET last_edited_at = last_edited_at WHERE id = v_id;
  SELECT updated_at INTO v_after FROM public.leads WHERE id = v_id;

  IF v_after IS NULL THEN
    RAISE EXCEPTION 'updated_at is null after an update';
  END IF;
  IF v_after <= v_before THEN
    RAISE EXCEPTION 'did not advance: before %, after %', v_before, v_after;
  END IF;

  INSERT INTO _results VALUES (2, 'leads.updated_at maintained', true,
                               'advanced without the client setting it');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (2, 'leads.updated_at maintained', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 03  Success resets the streak
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_row record;
BEGIN
  DELETE FROM public.google_sheets_sync_health;
  DELETE FROM public.google_sheets_sync_queue;

  PERFORM public.record_sheets_sync_success();
  SELECT * INTO v_row FROM public.google_sheets_sync_health WHERE id = 'global';

  IF v_row.consecutive_failures <> 0 THEN
    RAISE EXCEPTION 'streak is %, expected 0', v_row.consecutive_failures;
  END IF;
  IF v_row.status <> 'healthy' THEN
    RAISE EXCEPTION 'status is %, expected healthy', v_row.status;
  END IF;

  INSERT INTO _results VALUES (3, 'success resets streak', true, 'streak 0, healthy');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (3, 'success resets streak', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 04  One failure queues the lead, logs it, and degrades
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_lead  uuid;
  v_row   record;
  v_queue integer;
  v_errs  integer;
BEGIN
  SELECT id INTO v_lead FROM public.leads WHERE id IS NOT NULL LIMIT 1;

  PERFORM public.record_sheets_sync_failure('Apps Script quota exceeded', v_lead, 'sync');

  SELECT * INTO v_row FROM public.google_sheets_sync_health WHERE id = 'global';
  SELECT count(*) INTO v_queue FROM public.google_sheets_sync_queue WHERE lead_id = v_lead;
  SELECT count(*) INTO v_errs  FROM public.google_sheets_sync_errors WHERE lead_id = v_lead;

  IF v_row.consecutive_failures <> 1 THEN
    RAISE EXCEPTION 'streak is %, expected 1', v_row.consecutive_failures;
  END IF;
  IF v_row.status <> 'degraded' THEN
    RAISE EXCEPTION 'status is %, expected degraded', v_row.status;
  END IF;
  IF v_queue <> 1 THEN
    RAISE EXCEPTION 'queue rows %, expected 1', v_queue;
  END IF;
  IF v_errs <> 1 THEN
    RAISE EXCEPTION 'error log rows %, expected 1', v_errs;
  END IF;

  INSERT INTO _results VALUES (4, 'failure queues + logs + degrades', true,
                               'streak 1, degraded, 1 queued, 1 logged');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (4, 'failure queues + logs + degrades', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 05  Repeat failures accumulate on one queue row
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_lead    uuid;
  v_rows    integer;
  v_attempts integer;
BEGIN
  SELECT id INTO v_lead FROM public.leads WHERE id IS NOT NULL LIMIT 1;

  PERFORM public.record_sheets_sync_failure('timeout', v_lead, 'sync');
  PERFORM public.record_sheets_sync_failure('timeout', v_lead, 'sync');

  SELECT count(*), max(attempts) INTO v_rows, v_attempts
    FROM public.google_sheets_sync_queue WHERE lead_id = v_lead;

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'lead queued % times, expected 1', v_rows;
  END IF;
  IF v_attempts <> 3 THEN
    RAISE EXCEPTION 'attempts is %, expected 3 (one per failure)', v_attempts;
  END IF;

  INSERT INTO _results VALUES (5, 'repeat failures do not duplicate', true,
                               '1 row, attempts 3');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (5, 'repeat failures do not duplicate', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 06  Ten consecutive failures reports down
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_status text;
BEGIN
  DELETE FROM public.google_sheets_sync_health;

  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');

  SELECT status INTO v_status FROM public.google_sheets_sync_health WHERE id = 'global';
  IF v_status <> 'down' THEN
    RAISE EXCEPTION 'status is %, expected down', v_status;
  END IF;

  INSERT INTO _results VALUES (6, 'ten failures reports down', true, 'down');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (6, 'ten failures reports down', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 07  Success clears the queued retry
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_lead uuid; v_left integer;
BEGIN
  SELECT id INTO v_lead FROM public.leads WHERE id IS NOT NULL LIMIT 1;
  PERFORM public.record_sheets_sync_failure('boom', v_lead, 'sync');
  PERFORM public.record_sheets_sync_success(v_lead);

  SELECT count(*) INTO v_left FROM public.google_sheets_sync_queue WHERE lead_id = v_lead;
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% rows left in queue, expected 0', v_left;
  END IF;

  INSERT INTO _results VALUES (7, 'success clears queued retry', true, 'queue empty');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (7, 'success clears queued retry', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 08  Health exposes status, depth and recent errors
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_h record;
BEGIN
  PERFORM public.record_sheets_sync_failure('first error',  NULL, 'sync');
  PERFORM public.record_sheets_sync_failure('second error', NULL, 'sync');

  SELECT * INTO v_h FROM public.get_sheets_sync_health();

  IF v_h.status IS NULL OR v_h.status NOT IN ('healthy','degraded','down') THEN
    RAISE EXCEPTION 'unexpected status: %', v_h.status;
  END IF;
  IF v_h.queue_depth IS NULL THEN
    RAISE EXCEPTION 'queue_depth is null';
  END IF;
  IF v_h.recent_errors IS NULL OR jsonb_array_length(v_h.recent_errors) < 2 THEN
    RAISE EXCEPTION 'recent_errors has % entries, expected at least 2',
      COALESCE(jsonb_array_length(v_h.recent_errors), 0);
  END IF;

  INSERT INTO _results VALUES (8, 'health exposes state', true,
    format('status %, queue %, errors %', v_h.status, v_h.queue_depth,
           jsonb_array_length(v_h.recent_errors)));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (8, 'health exposes state', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 09  Only the last ten errors come back
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_h record;
BEGIN
  DELETE FROM public.google_sheets_sync_errors;
  FOR i IN 1..12 LOOP
    PERFORM public.record_sheets_sync_failure('e' || i, NULL, 'sync');
  END LOOP;

  SELECT * INTO v_h FROM public.get_sheets_sync_health();
  IF jsonb_array_length(v_h.recent_errors) <> 10 THEN
    RAISE EXCEPTION 'returned % entries, expected exactly 10',
      jsonb_array_length(v_h.recent_errors);
  END IF;

  INSERT INTO _results VALUES (9, 'recent errors capped at 10', true, '12 logged, 10 returned');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (9, 'recent errors capped at 10', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 10  Claiming respects the backoff window
--      A lead waiting out its retry delay must not be handed to a worker early.
--      This is the one check that cannot pass by inspection: it exercises
--      FOR UPDATE SKIP LOCKED against a real row.
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_lead uuid; v_claimed integer;
BEGIN
  DELETE FROM public.google_sheets_sync_queue;
  SELECT id INTO v_lead FROM public.leads WHERE id IS NOT NULL LIMIT 1;

  INSERT INTO public.google_sheets_sync_queue (lead_id, next_attempt_at)
  VALUES (v_lead, now() + interval '1 hour');

  SELECT count(*) INTO v_claimed FROM public.claim_sheets_sync_queue(25);
  IF v_claimed <> 0 THEN
    RAISE EXCEPTION 'claimed % rows before they were due', v_claimed;
  END IF;

  UPDATE public.google_sheets_sync_queue SET next_attempt_at = now() - interval '1 second';
  SELECT count(*) INTO v_claimed FROM public.claim_sheets_sync_queue(25);
  IF v_claimed <> 1 THEN
    RAISE EXCEPTION 'due row was not claimed (claimed %)', v_claimed;
  END IF;

  INSERT INTO _results VALUES (10, 'claim respects backoff', true,
                               'not-due skipped, due claimed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (10, 'claim respects backoff', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 11  A healthy sync raises no alert
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_sent integer;
BEGIN
  DELETE FROM public.google_sheets_sync_health;
  PERFORM public.record_sheets_sync_success();

  SELECT public.raise_sheets_sync_stale_alert(900, 15) INTO v_sent;
  IF v_sent <> 0 THEN
    RAISE EXCEPTION 'alerted % admin(s) while healthy', v_sent;
  END IF;

  INSERT INTO _results VALUES (11, 'healthy sync does not alert', true, '0 admins alerted');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (11, 'healthy sync does not alert', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 12  A down sync alerts every admin, then throttles itself
--      The alert is written by the database, so it fires with no browser open.
--      This is the check that covers the original complaint.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_first   integer;
  v_second  integer;
  v_admins  integer;
  v_titles  integer;
BEGIN
  DELETE FROM public.google_sheets_sync_health;
  DELETE FROM public.notifications WHERE title = '[Alert] Google Sheets sync is not current';

  FOR i IN 1..10 LOOP
    PERFORM public.record_sheets_sync_failure('boom', NULL, 'sync');
  END LOOP;

  SELECT count(*) INTO v_admins FROM public.user_roles WHERE role = 'admin';

  SELECT public.raise_sheets_sync_stale_alert(900, 15) INTO v_first;
  IF v_first <> v_admins THEN
    RAISE EXCEPTION 'alerted % of % admins', v_first, v_admins;
  END IF;

  SELECT public.raise_sheets_sync_stale_alert(900, 15) INTO v_second;
  IF v_second <> 0 THEN
    RAISE EXCEPTION 'throttle failed: second call inserted % rows', v_second;
  END IF;

  SELECT count(*) INTO v_titles FROM public.notifications
   WHERE title = '[Alert] Google Sheets sync is not current';
  IF v_titles <> v_first THEN
    RAISE EXCEPTION 'expected % notification rows, found %', v_first, v_titles;
  END IF;

  INSERT INTO _results VALUES (12, 'down sync alerts admins once', true,
                               format('%s admin(s) alerted, throttle held', v_first));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (12, 'down sync alerts admins once', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 13  anon cannot reach any of it
--      Tests BOTH layers. Testing only the tables is not enough: these
--      functions are SECURITY DEFINER, so they bypass the table policies
--      entirely. Postgres grants EXECUTE to PUBLIC on a new function by
--      default, which is exactly how anon reached them once already.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_health    boolean := false;
  v_errors    boolean := false;
  v_queue     boolean := false;
  v_fn_public text;
BEGIN
  -- Layer one: table privileges.
  SET LOCAL ROLE anon;
  BEGIN PERFORM 1 FROM public.google_sheets_sync_health LIMIT 1; v_health := true;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM 1 FROM public.google_sheets_sync_errors LIMIT 1; v_errors := true;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM 1 FROM public.google_sheets_sync_queue  LIMIT 1; v_queue  := true;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;

  IF v_health OR v_errors OR v_queue THEN
    RAISE EXCEPTION 'anon reached sync tables (health %, errors %, queue %)',
      v_health, v_errors, v_queue;
  END IF;

  -- Layer two: EXECUTE on the SECURITY DEFINER functions. This is the one
  -- that matters, because a grant here overrides every table policy.
  SELECT string_agg(fn, ', ' ORDER BY fn) INTO v_fn_public
    FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'record_sheets_sync_success','record_sheets_sync_failure',
           'claim_sheets_sync_queue','get_sheets_sync_health',
           'get_sheets_sync_queue_depth','prune_sheets_sync_errors',
           'raise_sheets_sync_stale_alert')
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ) leaked;

  IF v_fn_public IS NOT NULL THEN
    RAISE EXCEPTION 'anon can EXECUTE (they are SECURITY DEFINER, so table RLS is bypassed): %',
      v_fn_public;
  END IF;

  INSERT INTO _results VALUES (13, 'anon blocked from tables and functions', true,
                               'no table reads, no function EXECUTE');
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  INSERT INTO _results VALUES (13, 'anon blocked from tables and functions', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 13b authenticated admin must still be able to execute everything
--      Guards against fixing the anon hole by revoking from everyone.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(fn, ', ' ORDER BY fn) INTO v_missing
    FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'record_sheets_sync_success','record_sheets_sync_failure',
           'claim_sheets_sync_queue','get_sheets_sync_health',
           'get_sheets_sync_queue_depth','prune_sheets_sync_errors',
           'raise_sheets_sync_stale_alert')
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) missing;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated cannot execute: %', v_missing;
  END IF;

  INSERT INTO _results VALUES (15, 'authenticated can execute all', true, 'all 7 granted');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (15, 'authenticated can execute all', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 14  Pruning bounds the error log
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_kept integer;
BEGIN
  -- PERFORM discards the result. A bare SELECT here raises
  -- "query has no destination for result data".
  PERFORM public.prune_sheets_sync_errors(5);
  SELECT count(*) INTO v_kept FROM public.google_sheets_sync_errors;
  IF v_kept > 5 THEN
    RAISE EXCEPTION 'kept % rows, expected at most 5', v_kept;
  END IF;
  INSERT INTO _results VALUES (14, 'prune bounds error log', true, v_kept || ' rows kept');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (14, 'prune bounds error log', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- Results
-- -----------------------------------------------------------------------------
SELECT
  seq,
  name,
  CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
  detail
FROM _results
ORDER BY seq;

ROLLBACK;

-- =============================================================================
-- Every row should read PASS. Any FAIL carries the expected and actual values
-- in DETAIL. Nothing is committed.
-- =============================================================================