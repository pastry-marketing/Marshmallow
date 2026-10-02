-- =============================================================================
-- Manual harness: optimised areas and area performance
--
-- Covers 20261030140000_optimized_areas_and_area_performance.sql:
--   - optimized_areas table, its RLS and its unique key on state
--   - area_performance(), the evidence the approval tick depends on
--   - optimized_areas_with_performance(), the list the page renders
--   - parse_lead_location(), the single location definition everything shares
--
-- HOW TO RUN
--   Paste into the Supabase SQL Editor and run as `postgres`.
--   Nothing persists: the file opens a transaction and ROLLBACKs at the end.
--
--   Read the final "results" grid. Every check must read pass.
--
-- STRUCTURE NOTES
--   SET LOCAL ROLE cannot be issued inside a plpgsql block, so each role is a
--   separate top-level section. The results table is created while already
--   switched to authenticated so it owns it; GRANT ... ON SCHEMA pg_temp fails
--   with 3F000. Identities are discovered from user_roles at run time, because
--   a pinned UUID once belonged to an account with no role row and made the
--   harness deny its own positive case.
-- =============================================================================

BEGIN;

SET LOCAL ROLE authenticated;

CREATE TEMP TABLE _results (
  ord int, name text, passed boolean, detail text
) ON COMMIT DROP;

RESET ROLE;


-- ===========================================================================
-- 1. Location resolution - the shared definition
--
--    Must be identical everywhere it is used. These cases are the shapes that
--    actually appear in the data, including the malformed ones.
-- ===========================================================================
DO $$
DECLARE
  v_bad int := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT
      i.label,
      r.city, r.state, r.zip_code,
      CASE
        WHEN i.label = 'well formed'      THEN r.city = 'Lexington'  AND r.state = 'KY' AND r.zip_code = '40509'
        WHEN i.label = 'trailing country'  THEN r.city = 'San Diego'   AND r.state = 'CA' AND r.zip_code = '92119'
        WHEN i.label = 'no space in city'  THEN r.city = 'San Antonio' AND r.state = 'TX' AND r.zip_code = '78260'
        WHEN i.label = 'two word city'     THEN r.city = 'Fort Lauderdale'
        WHEN i.label = 'explicit columns'  THEN r.city = 'Dallas'      AND r.state = 'TX'
        WHEN i.label = 'dirty state field' THEN r.state = 'TX'
        WHEN i.label = 'no zip at all'     THEN r.state IS NULL AND r.zip_code IS NULL
        ELSE true
      END AS ok
    FROM (VALUES
      ('well formed',      '3752 Sunflower St, Lexington, KY 40509',    NULL,    NULL,    NULL),
      ('trailing country', '6960 Casselberry Way San Diego, CA 92119, USA', NULL, NULL,    NULL),
      ('no space in city', '2350 Estate Gate Dr San Antonio, TX 78260', NULL,    NULL,    NULL),
      ('two word city',    '3508 SW 15th Ct Fort Lauderdale, FL 33312', NULL,   NULL,    NULL),
      ('explicit columns', '999 somewhere',                             'Dallas', 'TX',  '75201'),
      ('dirty state field','888 elsewhere',                             NULL,    'MI 49022', NULL),
      ('no zip at all',    'somewhere with no postcode at all',          NULL,    NULL,    NULL)
    ) AS i(label, addr, city, state, zip)
    CROSS JOIN LATERAL public.parse_lead_location(i.addr, i.city, i.state, i.zip) AS r
  LOOP
    IF NOT rec.ok THEN
      v_bad := v_bad + 1;
      RAISE NOTICE 'location case failed: % (city=%, state=%, zip=%)',
        rec.label, rec.city, rec.state, rec.zip_code;
    END IF;
  END LOOP;

  INSERT INTO _results VALUES
    (1, 'parse_lead_location handles every known address shape', v_bad = 0, 'failed cases=' || v_bad);
END $$;


-- ===========================================================================
-- 2. Area evidence - admin sees numbers, and they must be non-zero
-- ===========================================================================
DO $$
DECLARE
  v_admin        uuid;
  v_tx_closed    bigint;
  v_tx_cancelled bigint;
  v_tx_rate      numeric;
  v_ca_closed    bigint;
BEGIN
  SELECT user_id INTO v_admin FROM public.user_roles WHERE role::text = 'admin' LIMIT 1;
  IF v_admin IS NULL THEN
    INSERT INTO _results VALUES (2, 'an admin account exists', false, 'no admin role row');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

  SELECT paid_count, cancelled_count, closed_rate_pct
    INTO v_tx_closed, v_tx_cancelled, v_tx_rate
    FROM public.area_performance(NULL, 'TX', NULL);

  SELECT paid_count INTO v_ca_closed
    FROM public.area_performance(NULL, 'CA', NULL);

  INSERT INTO _results VALUES
    (3, 'TX has closed jobs',        coalesce(v_tx_closed, 0) > 0, 'closed=' || coalesce(v_tx_closed, 0)),
    (4, 'CA has closed jobs',        coalesce(v_ca_closed, 0) > 0, 'closed=' || coalesce(v_ca_closed, 0)),
    -- closed / (closed + cancelled): the number the tick is judged on
    (5, 'closed rate is 0-100',      v_tx_rate IS NULL OR (v_tx_rate >= 0 AND v_tx_rate <= 100),
                                     'rate=' || coalesce(v_tx_rate::text, 'null')),
    (6, 'unknown state returns zeros',
        coalesce((SELECT paid_count FROM public.area_performance(NULL, 'ZZ', NULL)), 0) = 0,
        'ZZ closed=' || coalesce((SELECT paid_count FROM public.area_performance(NULL, 'ZZ', NULL)), 0));
END $$;


-- ===========================================================================
-- 3. Marking an area - insert, idempotent re-mark, deactivate
-- ===========================================================================
DO $$
DECLARE
  v_admin uuid;
  v_id1   uuid;
  v_rows  int;
BEGIN
  SELECT user_id INTO v_admin FROM public.user_roles WHERE role::text = 'admin' LIMIT 1;

  -- unique key is the state, so marking the same state twice must not duplicate
  INSERT INTO public.optimized_areas (state, city, zip_code, label, marked_by)
  VALUES ('TX', 'Dallas', '75201', 'Dallas, TX 75201', v_admin)
  ON CONFLICT (state) DO NOTHING;

  INSERT INTO public.optimized_areas (state, city, zip_code, label, marked_by)
  VALUES ('TX', 'Houston', '77001', 'Houston, TX 77001', v_admin)
  ON CONFLICT (state) DO UPDATE SET city = EXCLUDED.city, marked_at = now();

  SELECT count(*) INTO v_rows FROM public.optimized_areas WHERE state = 'TX';
  SELECT id INTO v_id1 FROM public.optimized_areas WHERE state = 'TX' ORDER BY marked_at DESC LIMIT 1;

  INSERT INTO _results VALUES
    (7, 'same state does not duplicate', v_rows = 1, 'TX rows=' || v_rows);

  -- the marked state must show up with live counts
  SELECT count(*) INTO v_rows FROM public.optimized_areas_with_performance() WHERE state = 'TX';
  INSERT INTO _results VALUES
    (8, 'marked area appears with counts', v_rows = 1, 'rows=' || v_rows);

  -- deactivating keeps the record rather than deleting the decision
  UPDATE public.optimized_areas SET is_active = false WHERE id = v_id1;
  SELECT count(*) INTO v_rows FROM public.optimized_areas WHERE state = 'TX' AND is_active = false;
  INSERT INTO _results VALUES
    (9, 'unmark keeps the row', v_rows = 1, 'inactive rows=' || v_rows);

  -- Re-activated and deliberately LEFT IN PLACE. The role checks below count
  -- the rows a caller can see, which only proves anything if a row exists: an
  -- empty table reads as "nothing visible" to everybody and would pass for the
  -- wrong reason. It is removed in the cleanup step near the end.
  UPDATE public.optimized_areas SET is_active = true WHERE id = v_id1;
END $$;


-- ===========================================================================
-- 4. Role gate - processor must see no rows and cannot reach the aggregate
--
--    Row-level security does not raise. A policy that excludes a caller
--    returns zero rows and the query still succeeds, so this counts rows
--    rather than expecting 42501. Only the SECURITY DEFINER aggregate is
--    expected to raise, because it checks the caller's role itself.
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub',
  coalesce((SELECT user_id::text FROM public.user_roles WHERE role::text = 'processor' LIMIT 1), ''), true);
SELECT set_config('request.jwt.claims',
  coalesce((SELECT json_build_object('sub', user_id::text, 'role', 'authenticated')::text
              FROM public.user_roles WHERE role::text = 'processor' LIMIT 1), ''), true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_seen int;
BEGIN
  -- Direct table read. Expect success with zero rows, not an error.
  SELECT count(*) INTO v_seen FROM public.optimized_areas;
  INSERT INTO _results VALUES
    (10, 'processor sees no optimized areas', v_seen = 0, 'rows visible=' || v_seen);

  -- and cannot reach the aggregate
  BEGIN
    PERFORM * FROM public.area_performance(NULL, 'TX', NULL);
    INSERT INTO _results VALUES (11, 'processor denied area_performance', false, 'was allowed');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _results VALUES (11, 'processor denied area_performance', true, '42501 as expected');
  END;
END $$;

RESET ROLE;


-- 5. signed out - expect no rows, and 42501 from the aggregate
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_seen int;
BEGIN
  SELECT count(*) INTO v_seen FROM public.optimized_areas;
  INSERT INTO _results VALUES
    (13, 'signed out sees no optimized areas', v_seen = 0, 'rows visible=' || v_seen);

  BEGIN
    PERFORM * FROM public.area_performance(NULL, 'TX', NULL);
    INSERT INTO _results VALUES (12, 'signed out denied area_performance', false, 'was allowed');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _results VALUES (12, 'signed out denied area_performance', true, '42501 as expected');
  END;
END $$;

RESET ROLE;


-- ===========================================================================
-- 5b. Control - the row really is there and an admin really can see it
--
--    Without this the two checks above pass vacuously. "0 rows visible"
--    proves the caller was blocked only if an admin looking at the same
--    moment sees the row.
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub',
  coalesce((SELECT user_id::text FROM public.user_roles WHERE role::text = 'admin' LIMIT 1), ''), true);
SELECT set_config('request.jwt.claims',
  coalesce((SELECT json_build_object('sub', user_id::text, 'role', 'authenticated')::text
              FROM public.user_roles WHERE role::text = 'admin' LIMIT 1), ''), true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_seen int;
BEGIN
  SELECT count(*) INTO v_seen FROM public.optimized_areas WHERE state = 'TX';
  INSERT INTO _results VALUES
    (22, 'admin sees the marked area', v_seen = 1, 'rows visible=' || v_seen);
END $$;

RESET ROLE;

-- leave no residue even before the ROLLBACK
DELETE FROM public.optimized_areas WHERE state = 'TX';


-- ===========================================================================
-- 6. Structural checks as postgres
-- ===========================================================================
DO $$
DECLARE
  v_rls      boolean;
  v_policies int;
  v_unique   int;
  v_anon_tbl boolean;
  v_anon_fn  boolean;
  v_auth_fn  boolean;
  v_pinned   int;
  v_definer  int;
BEGIN
  SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'optimized_areas';

  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'optimized_areas';

  SELECT count(*) INTO v_unique
    FROM pg_constraint
   WHERE conrelid = 'public.optimized_areas'::regclass AND contype = 'u';

  SELECT has_table_privilege('anon', 'public.optimized_areas', 'SELECT') INTO v_anon_tbl;

  SELECT has_function_privilege('anon', 'public.area_performance(text,text,text)', 'EXECUTE') INTO v_anon_fn;
  SELECT has_function_privilege('authenticated', 'public.area_performance(text,text,text)', 'EXECUTE') INTO v_auth_fn;

  -- both aggregates must be SECURITY DEFINER with search_path pinned
  SELECT count(*) INTO v_pinned
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('area_performance', 'optimized_areas_with_performance')
     AND array_to_string(p.proconfig, ',') LIKE '%search_path%';

  SELECT count(*) INTO v_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('area_performance', 'optimized_areas_with_performance')
     AND p.prosecdef;

  INSERT INTO _results VALUES
    (14, 'optimized_areas has RLS enabled',   coalesce(v_rls, false),  coalesce(v_rls::text, 'no table')),
    (15, 'all four policies present',         v_policies = 4,        'policies=' || v_policies),
    (16, 'unique key on state',               v_unique = 1,          'unique constraints=' || v_unique),
    (17, 'anon has no table access',          v_anon_tbl = false,    'anon select=' || v_anon_tbl),
    (18, 'anon cannot execute area_performance', v_anon_fn = false, 'anon execute=' || v_anon_fn),
    (19, 'authenticated can execute',         v_auth_fn = true,      'auth execute=' || v_auth_fn),
    (20, 'aggregates are SECURITY DEFINER',   v_definer = 2,         'definer fns=' || v_definer),
    (21, 'aggregates pin search_path',        v_pinned = 2,          'pinned=' || v_pinned);
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
  RAISE NOTICE 'optimized areas: % failures, % passes', v_fail, v_pass;
END $$;

-- =============================================================================
-- ROLLBACK (run manually if you need to undo this harness):
--   DROP TABLE IF EXISTS _final;
--   DROP TABLE IF EXISTS _results;
-- =============================================================================

ROLLBACK;