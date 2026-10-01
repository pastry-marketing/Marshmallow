-- =============================================================================
-- Manual harness: tech_paid_performance (Optimization section)
--
-- Verifies the function added in
-- 20261030120000_tech_paid_performance.sql before the frontend depends on it.
--
-- HOW TO RUN
--   Paste into the Supabase SQL Editor and run as `postgres`.
--   Nothing persists: the file opens a transaction and ROLLBACKs at the end.
--
--   Read the final "results" grid. Every check must read pass.
--
-- WHY NO HARDCODED USER IDS
--   An earlier version pinned a specific admin UUID. That account turned out to
--   hold no row in public.user_roles at all, and because the function checks
--   the caller's role itself rather than trusting RLS, the harness denied its
--   own positive case and looked like a product bug. Every identity below is
--   therefore discovered at run time, so the harness cannot go stale when
--   accounts are created, deleted or re-roled.
--
-- STRUCTURE NOTES - both learned the hard way
--   SET LOCAL ROLE cannot be issued inside a plpgsql block, so each role is a
--   separate top-level section rather than a DO block that switches role.
--   The results table is created while already switched to authenticated so
--   that role owns it and can write to it; postgres writes to it too because it
--   is a superuser. GRANT ... ON SCHEMA pg_temp fails with 3F000.
--
--   The positive case runs as postgres with the JWT claim set to a real admin.
--   That is deliberate: it proves the aggregate is correct, while the negative
--   cases below prove the role gate from a real authenticated session.
-- =============================================================================

BEGIN;

-- results table is owned by authenticated, so the authenticated sections can
-- write to it without any grants
SET LOCAL ROLE authenticated;

CREATE TEMP TABLE _results (
  ord  int, name text, passed boolean, detail text
) ON COMMIT DROP;

RESET ROLE;


-- ===========================================================================
-- 1. admin - expect 0 failures
--
--    Baseline from the live data on 2026-09-30:
--      308 distinct technicians, 369 paid leads naming a technician,
--      244 cancelled naming a technician. The totals matter more than the row
--      count: they prove the technicians join did not fan out, which is the
--      whole reason the aggregate is computed in SQL rather than in the browser.
-- ===========================================================================
DO $$
DECLARE
  v_admin           uuid;
  v_total_paid      bigint;
  v_total_cancelled bigint;
  v_rows            bigint;
  v_bad_rate        bigint;
  v_blank_label     bigint;
  v_dupes           bigint;
  v_bad_state       bigint;
  v_bad_zip         bigint;
BEGIN
  SELECT user_id INTO v_admin
    FROM public.user_roles
   WHERE role::text = 'admin'
   LIMIT 1;

  IF v_admin IS NULL THEN
    INSERT INTO _results VALUES (0, 'an admin account exists', false, 'no admin role row found');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  CREATE TEMP TABLE _perf AS
    SELECT * FROM public.tech_paid_performance(NULL, NULL);

  SELECT count(*) INTO v_rows FROM _perf;
  SELECT coalesce(sum(paid_count), 0)      INTO v_total_paid      FROM _perf;
  SELECT coalesce(sum(cancelled_count), 0) INTO v_total_cancelled FROM _perf;

  SELECT count(*) INTO v_bad_rate FROM _perf
    WHERE paid_rate_pct IS NOT NULL
      AND (paid_rate_pct < 0 OR paid_rate_pct > 100);

  SELECT count(*) INTO v_blank_label FROM _perf
    WHERE coalesce(btrim(location_label), '') = '';

  -- one row per technician: duplicated technician names must not produce a
  -- second row or inflate the counts
  SELECT count(*) INTO v_dupes FROM (
    SELECT tech_name FROM _perf GROUP BY tech_name HAVING count(*) > 1
  ) d;

  -- state must be a real two-letter code and zip a real 5 digit code, otherwise
  -- the page would group locations on values that came out of the address parser
  SELECT count(*) INTO v_bad_state FROM _perf
    WHERE state IS NOT NULL AND state !~ '^[A-Z]{2}$';

  SELECT count(*) INTO v_bad_zip FROM _perf
    WHERE zip_code IS NOT NULL AND zip_code !~ '^[0-9]{5}(-[0-9]{4})?$';

  INSERT INTO _results VALUES
    (1, 'function returns rows',
        v_rows > 0,
        'rows=' || v_rows || ' admin=' || v_admin),

    (2, 'paid total matches live baseline',
        v_total_paid = 369,
        'got ' || v_total_paid || ', expected 369'),

    (3, 'cancelled total matches live baseline',
        v_total_cancelled = 244,
        'got ' || v_total_cancelled || ', expected 244'),

    (4, 'no fan-out: one row per technician',
        v_dupes = 0,
        'duplicate tech_names=' || v_dupes),

    (5, 'paid rate within 0-100',
        v_bad_rate = 0,
        'out of range=' || v_bad_rate),

    (6, 'every row has a location label',
        v_blank_label = 0,
        'blank=' || v_blank_label),

    (7, 'state is a clean two-letter code',
        v_bad_state = 0,
        'bad=' || v_bad_state),

    (8, 'zip is a clean 5 digit code',
        v_bad_zip = 0,
        'bad=' || v_bad_zip);

END $$;


-- ===========================================================================
-- 2. processor - expect 42501 (permission denied)
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub',
  coalesce((SELECT user_id::text FROM public.user_roles WHERE role::text = 'processor' LIMIT 1), ''), true);
SELECT set_config('request.jwt.claims',
  coalesce((SELECT json_build_object('sub', user_id::text, 'role', 'authenticated')::text
              FROM public.user_roles WHERE role::text = 'processor' LIMIT 1), ''), true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.tech_paid_performance(NULL, NULL);
    INSERT INTO _results VALUES (9, 'processor is denied', false, 'was allowed');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _results VALUES (9, 'processor is denied', true, '42501 as expected');
  END;
END $$;

RESET ROLE;


-- ===========================================================================
-- 3. customer service - expect 42501
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub',
  coalesce((SELECT user_id::text FROM public.user_roles WHERE role::text = 'customer_service' LIMIT 1), ''), true);
SELECT set_config('request.jwt.claims',
  coalesce((SELECT json_build_object('sub', user_id::text, 'role', 'authenticated')::text
              FROM public.user_roles WHERE role::text = 'customer_service' LIMIT 1), ''), true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.tech_paid_performance(NULL, NULL);
    INSERT INTO _results VALUES (10, 'customer service is denied', false, 'was allowed');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _results VALUES (10, 'customer service is denied', true, '42501 as expected');
  END;
END $$;

RESET ROLE;


-- ===========================================================================
-- 4. signed out - expect 42501, no session at all
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.tech_paid_performance(NULL, NULL);
    INSERT INTO _results VALUES (11, 'signed out is denied', false, 'was allowed');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _results VALUES (11, 'signed out is denied', true, '42501 as expected');
  END;
END $$;

RESET ROLE;


-- ===========================================================================
-- 5. structural checks as postgres
--
--    The function is SECURITY DEFINER, so it bypasses RLS and must own its own
--    role check and pin search_path. anon must hold no execute grant.
-- ===========================================================================
DO $$
DECLARE
  v_definer boolean;
  v_search  text;
  v_anon    boolean;
  v_auth    boolean;
  v_index   boolean;
BEGIN
  SELECT prosecdef INTO v_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tech_paid_performance';

  SELECT array_to_string(p.proconfig, ',') INTO v_search
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tech_paid_performance';

  SELECT has_function_privilege('anon', 'public.tech_paid_performance(timestamptz,timestamptz)', 'EXECUTE')
    INTO v_anon;

  SELECT has_function_privilege('authenticated', 'public.tech_paid_performance(timestamptz,timestamptz)', 'EXECUTE')
    INTO v_auth;

  SELECT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'leads_tech_performance_idx')
    INTO v_index;

  INSERT INTO _results VALUES
    (12, 'function is SECURITY DEFINER', coalesce(v_definer, false), coalesce(v_definer::text, 'missing')),
    (13, 'search_path is pinned',        v_search LIKE '%search_path%', coalesce(v_search, '(none)')),
    (14, 'anon cannot execute',          v_anon = false, 'anon execute=' || v_anon),
    (15, 'authenticated can execute',    v_auth = true,  'auth execute=' || v_auth),
    (16, 'supporting index exists',      v_index,        'index=' || v_index);
END $$;


-- results - every check must read pass
CREATE TEMP TABLE _final AS
SELECT ord, name,
       CASE WHEN passed THEN 'pass' ELSE 'FAIL' END AS status,
       passed, detail
  FROM _results
 ORDER BY ord;

SELECT * FROM _final;

DO $$
DECLARE v_fail int; v_pass int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed) INTO v_fail FROM _results;
  SELECT count(*) FILTER (WHERE passed)     INTO v_pass FROM _results;
  RAISE NOTICE 'tech_paid_performance: % failures, % passes', v_fail, v_pass;
END $$;

-- =============================================================================
-- ROLLBACK (run manually if you need to undo this harness):
--   DROP TABLE IF EXISTS _final;
--   DROP TABLE IF EXISTS _results;
-- =============================================================================

ROLLBACK;
