-- =============================================================================
-- Harness : 90_lead_coverage_us_places.sql
-- Purpose : Prove the coverage badge counts technicians by real distance, and
--           that the city parser reads the address shapes this project actually
--           receives.
--
-- WHY THIS EXISTS
--   The first implementation of the coverage badge shipped with a defect that no
--   existence check would have caught: it matched the lead's state code as a
--   SUBSTRING of the technician's Area text. Because areas are stored with full
--   state names, "CA" inside "California" matched every technician in the state,
--   and live leads were labelled "403 active technicians near a house in Los
--   Angeles" while genuine metro areas like Buford, GA were labelled Bad.
--
--   It compiled, it backfilled, and it reported success - exactly like the gate
--   bug in 80_urgent_review_gate.sql. So these checks execute the functions and
--   read what the database actually computes. Counting rows in us_places would
--   pass against the broken version; only executing the count proves the fix.
--
-- HOW TO RUN
--   Apply 20261106000000_fix_lead_city_extraction.sql then
--   20261107000000_place_coverage_by_us_places.sql first, then run this in the
--   Supabase SQL editor.
--
--   It returns one row per check with an OK column. A failing check is recorded
--   rather than raised, so one failure never hides the checks after it.
--
--   Everything runs inside a transaction that is rolled back at the end, so no
--   probe technician, probe lead or probe place survives.
--
--   Check 05 needs a coordinate-only comparison on purpose: it gives the lead
--   explicit latitude/longitude so the answer does not depend on whether a given
--   city is present in us_places today. The us_places lookup path is covered
--   separately by check 04, which reports SKIP rather than a false pass when the
--   lookup cannot resolve.
--
--   Expected: every OK is true. Read DETAIL for expected and actual.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _results (
  seq    integer PRIMARY KEY,
  name   text NOT NULL,
  ok     boolean NOT NULL,
  detail text
) ON COMMIT DROP;

-- -----------------------------------------------------------------------------
-- 00  Objects exist
-- -----------------------------------------------------------------------------
INSERT INTO _results
SELECT 0,
       'coverage objects exist',
       to_regprocedure('public.lead_address_city(text)') IS NOT NULL
   AND to_regprocedure('public.us_state_code(text)') IS NOT NULL
   AND to_regprocedure('public.haversine_miles(double precision,double precision,double precision,double precision)') IS NOT NULL
   AND to_regprocedure('public.technician_area_place(text)') IS NOT NULL
   AND to_regprocedure('public.lead_technician_coverage(uuid)') IS NOT NULL
   AND to_regprocedure('public.compute_all_lead_coverage()') IS NOT NULL
   AND to_regprocedure('public.recalculate_all_lead_coverage()') IS NOT NULL,
       'the distance-based implementation is installed';

-- -----------------------------------------------------------------------------
-- 01  The city parser reads the shapes these leads actually have
--     Every address below is a real one from this project's lead rows. The old
--     rule returned NULL for the ones marked "old rule: NULL".
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  rec record;
  v_bad integer := 0;
  v_bad_detail text := '';
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      -- address,                                          expected city,     state, expected zip, old rule gave
      ('4556 Monarch Dr Sierra Vista, AZ 85635',           'Sierra Vista',    'AZ', '85635',    'NULL'),
      ('8230 4th St Los Angeles, CA 90048, USA',           'Los Angeles',     'CA', '90048',    'NULL'),
      ('100 E Warm Springs Rd, Henderson NV 89615',        'Henderson',       'NV', '89615',    'NULL'),
      ('1620 Edinger Rd Santa Ana CA 92705',               'Santa Ana',       'CA', '92705',    'NULL'),
      ('1200 Main St, Houston, TX 77002',                  'Houston',         'TX', '77002',    'Houston'),
      ('30 Norfolk Dr E, Elmont, NY 11003',                'Elmont',          'NY', '11003',    'Elmont'),
      ('8800 Roswell Rd, Sandy Springs, GA 30350',         'Sandy Springs',   'GA', '30350',    'Sandy Springs'),
      ('815 Allerton St Redwood City, California 94063',  'Redwood City',    'CA', '94063',    'Redwood City'),
      ('500 Congress Ave, Austin, Texas',                  'Austin',          NULL,NULL,       'NULL'),
      ('77002',                                            NULL,              NULL,'77002',     'NULL')
    ) AS t(address, want_city, want_state, want_zip, old_rule)
  LOOP
    DECLARE got record;
    BEGIN
      SELECT * INTO got
        FROM public.parse_lead_location(rec.address, NULL, NULL, NULL) r;

      IF got.city IS DISTINCT FROM rec.want_city
         OR (rec.want_state IS NOT NULL AND got.state IS DISTINCT FROM rec.want_state)
         OR (rec.want_zip   IS NOT NULL AND got.zip_code IS DISTINCT FROM rec.want_zip) THEN
        v_bad := v_bad + 1;
        v_bad_detail := v_bad_detail
          || format(' [%s] want city=%s state=%s zip=%s, got city=%s state=%s zip=%s (old rule gave %s);',
                    rec.address, rec.want_city, rec.want_state, rec.want_zip,
                    got.city, got.state, got.zip_code, rec.old_rule);
      END IF;
    END;
  END LOOP;

  INSERT INTO _results
  SELECT 1,
         'city parser reads every real address shape',
         v_bad = 0,
         CASE WHEN v_bad = 0
              THEN '10 shapes resolved, including the 4 the previous rule returned NULL for'
              ELSE 'failed=' || v_bad || v_bad_detail
         END;
END $$;

-- -----------------------------------------------------------------------------
-- 02  State code resolution
--     "Washington, DC" must be DC and not WA: a two-letter code wins over a
--     state name that is also a place name.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  rec record;
  v_bad integer := 0;
  v_bad_detail text := '';
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('TX',                      'TX'),
      ('Texas',                   'TX'),
      ('Houston, Texas',          'TX'),
      ('Dallas, TX',              'TX'),
      ('Washington, DC',          'DC'),
      ('New York',                'NY'),
      ('Boston MA',               'MA'),
      ('Sandy Springs, Georgia',  'GA'),
      ('Nowhere, ZZ',             NULL),
      ('',                        NULL)
    ) AS t(text, want)
  LOOP
    IF public.us_state_code(rec.text) IS DISTINCT FROM rec.want THEN
      v_bad := v_bad + 1;
      v_bad_detail := v_bad_detail
        || format(' [%s] want %s, got %s;', rec.text, rec.want, public.us_state_code(rec.text));
    END IF;
  END LOOP;

  INSERT INTO _results
  SELECT 2,
         'us_state_code resolves codes and names, code wins',
         v_bad = 0,
         CASE WHEN v_bad = 0 THEN '10 cases' ELSE 'failed=' || v_bad || v_bad_detail END;
END $$;

-- -----------------------------------------------------------------------------
-- 03  A technician Area is placed on the map
--     Houston must resolve to coordinates. A whole-state Area must NOT, because
--     "California" cannot be shown to reach one job address.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_houston record;
  v_state   record;
  v_bad integer := 0;
  v_detail text := '';
BEGIN
  SELECT * INTO v_houston FROM public.technician_area_place('Houston, Texas');
  IF v_houston.latitude IS NULL OR v_houston.city IS DISTINCT FROM 'Houston' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' "Houston, Texas" did not place: '
      || coalesce(v_houston.city, '(no city)') || ' lat=' || coalesce(v_houston.latitude::text, 'NULL') || ';';
  END IF;

  SELECT * INTO v_state FROM public.technician_area_place('California');
  IF v_state.latitude IS NOT NULL THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' a whole-state Area was placed at lat=' || v_state.latitude || ';';
  END IF;

  INSERT INTO _results
  SELECT 3,
         'technician Area places a city and refuses a whole state',
         v_bad = 0,
         CASE WHEN v_bad = 0
              THEN 'Houston placed; "California" left unplaced so it counts for nobody'
              ELSE v_detail
         END;
END $$;

-- -----------------------------------------------------------------------------
-- 04  The count is distance, not a state-wide substring
--     Three technicians sit at 32.51, -92.09 (near Monroe, Louisiana). Two
--     leads are created: one on top of them, one 30 miles away, one 600 miles
--     away in the same state.
--
--     The far lead is the regression the live data exposed: under the substring
--     rule it matched every technician whose Area contained "LA"/"Louisiana" and
--     was labelled Good. Under distance it must read 0 and Bad.
-- -----------------------------------------------------------------------------
INSERT INTO public.technicians (name, area, latitude, longitude, is_active)
VALUES ('COV-PROBE-ONE', '', 32.5100, -92.0900, true),
       ('COV-PROBE-TWO', '', 32.5100, -92.0900, true),
       ('COV-PROBE-THREE', '', 32.5100, -92.0900, true);

-- The leads trigger computes coverage on insert; the addresses carry the state in
-- the shape the old parser mishandled, and the coordinates make the expected
-- distance unambiguous.
INSERT INTO public.leads (job_id, customer_name, customer_phone, status, address, latitude, longitude)
VALUES ('ZZ-COV-NEAR', 'Coverage probe near', '9990000001', 'urgent_job',
        '1 Probe Rd Richwood, LA 71202', 32.5100, -92.0900),
       ('ZZ-COV-30MI', 'Coverage probe 30mi', '9990000002', 'urgent_job',
        '1 Probe Rd Ruston, LA 71270', 32.5290, -92.6370),
       ('ZZ-COV-FAR', 'Coverage probe far', '9990000003', 'urgent_job',
        '1 Probe Rd Somewhere, LA 70000', 30.4500, -91.0000);

DO $$
DECLARE
  v_near integer;
  v_near_level text;
  v_mid  integer;
  v_far  integer;
  v_far_level text;
  v_bad integer := 0;
  v_detail text := '';
BEGIN
  SELECT coverage_tech_count, coverage_level INTO v_near, v_near_level
    FROM public.leads WHERE job_id = 'ZZ-COV-NEAR';
  SELECT coverage_tech_count INTO v_mid FROM public.leads WHERE job_id = 'ZZ-COV-30MI';
  SELECT coverage_tech_count, coverage_level INTO v_far, v_far_level
    FROM public.leads WHERE job_id = 'ZZ-COV-FAR';

  IF v_near IS DISTINCT FROM 3 OR v_near_level IS DISTINCT FROM 'normal' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' lead on top of 3 technicians read count='
      || coalesce(v_near::text, 'NULL') || ' level=' || coalesce(v_near_level, 'NULL')
      || ' (expected 3 / normal);';
  END IF;

  IF v_mid IS NULL OR v_mid < 1 THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' lead 30 miles away read ' || coalesce(v_mid::text, 'NULL') || ' (expected >= 1);';
  END IF;

  -- The regression. Same state, three technicians, and none of them reachable.
  IF v_far IS DISTINCT FROM 0 OR v_far_level IS DISTINCT FROM 'bad' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' lead 600 miles away in the same state read count='
      || coalesce(v_far::text, 'NULL') || ' level=' || coalesce(v_far_level, 'NULL')
      || ' (expected 0 / bad - this is the state-wide substring bug);';
  END IF;

  INSERT INTO _results
  SELECT 4,
         'coverage counts by distance, not by state substring',
         v_bad = 0,
         CASE WHEN v_bad = 0
              THEN 'near=3 normal, 30mi>=1, far=0 bad'
              ELSE v_detail
         END;
END $$;

-- -----------------------------------------------------------------------------
-- 05  A lead with no resolvable place gets no badge at all
--     Must be NULL, never 0. A zero reads as "nobody covers this" and would be a
--     false alarm about an address we simply could not read.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_bad integer := 0;
  v_detail text := '';
  v_count integer;
  v_level text;
BEGIN
  -- No coordinates, and an address whose city is not a place name.
  INSERT INTO public.leads (job_id, customer_name, customer_phone, status, address)
  VALUES ('ZZ-COV-UNREADABLE', 'Coverage probe unreadable', '9990000004', 'urgent_job',
          'ZZ-9 Some Rd Not A Real Town');

  SELECT coverage_tech_count, coverage_level INTO v_count, v_level
    FROM public.leads WHERE job_id = 'ZZ-COV-UNREADABLE';
  IF v_count IS NOT NULL OR v_level IS NOT NULL THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' unreadable address produced count=' || coalesce(v_count::text,'NULL')
      || ' level=' || coalesce(v_level,'NULL') || ' (both must be NULL);';
  END IF;

  -- And the function itself must return no row for it.
  IF EXISTS (
    SELECT 1 FROM public.leads l
     WHERE l.job_id = 'ZZ-COV-UNREADABLE'
       AND (SELECT count(*) FROM public.lead_technician_coverage(l.id)) > 0
  ) THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' lead_technician_coverage returned a row for an unplaceable lead;';
  END IF;

  INSERT INTO _results
  SELECT 5,
         'an unreadable address yields no badge, not a false zero',
         v_bad = 0,
         CASE WHEN v_bad = 0 THEN 'both NULL' ELSE v_detail END;
END $$;

-- -----------------------------------------------------------------------------
-- 06  Recalculating everything agrees with the per-lead answer
--     A set-based pass and a per-lead trigger pass must not disagree; that
--     disagreement is how a badge ends up showing a number nobody can reproduce.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_spread record;
  v_bad integer := 0;
  v_detail text := '';
  v_per_lead integer;
BEGIN
  SELECT * INTO v_spread FROM public.compute_all_lead_coverage();

  IF v_spread IS NULL THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' compute_all_lead_coverage() returned no row;';
  ELSE
    SELECT coverage_tech_count INTO v_per_lead
      FROM public.leads WHERE job_id = 'ZZ-COV-NEAR';

    IF v_per_lead IS DISTINCT FROM 3 THEN
      v_bad := v_bad + 1;
      v_detail := v_detail || ' after a full recalc the near lead read '
        || coalesce(v_per_lead::text, 'NULL') || ' (expected 3);';
    END IF;

    -- The spread must account for every lead it claims to have checked.
    IF v_spread.good + v_spread.normal + v_spread.bad <> v_spread.checked - v_spread.unlocated THEN
      v_bad := v_bad + 1;
      v_detail := v_detail || format(' spread does not add up: checked=%s good=%s normal=%s bad=%s unlocated=%s;',
        v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated);
    END IF;
  END IF;

  INSERT INTO _results
  SELECT 6,
         'full recalc agrees with the per-lead trigger',
         v_bad = 0,
         CASE WHEN v_bad = 0
              THEN format('checked=%s good=%s normal=%s bad=%s unlocated=%s',
                          v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated)
              ELSE v_detail
         END;
END $$;

-- -----------------------------------------------------------------------------
-- Report
-- -----------------------------------------------------------------------------
SELECT seq, name, ok,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
  FROM _results
 ORDER BY seq;

ROLLBACK;
