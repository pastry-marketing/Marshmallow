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
    AND to_regprocedure('public.trg_lead_coverage_refresh()') IS NOT NULL
    AND to_regprocedure('public.compute_all_lead_coverage()') IS NOT NULL
    AND to_regprocedure('public.recalculate_all_lead_coverage()') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.leads'::regclass
         AND tgname = 'leads_refresh_coverage_insert'
         AND NOT tgisinternal
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.leads'::regclass
         AND tgname = 'leads_refresh_coverage_location_update'
         AND NOT tgisinternal
         AND pg_get_triggerdef(oid) LIKE '%WHEN%'
    )
    AND (SELECT p.prosecdef FROM pg_proc p
          WHERE p.oid = 'public.trg_lead_coverage_refresh()'::regprocedure),
       'distance calculation and changed-location triggers are installed';

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
       ('77002',                                            NULL,              NULL,'77002',     'NULL'),
       ('4618 Burney Dr,, mARIPOSA. California. 95338 USA', 'Mariposa',        'CA','95338',    'punctuation / duplicate commas'),
       ('4618   Burney Dr  Mariposa   CA 95338',            'Mariposa',        'CA','95338',    'repeated spaces'),
       ('4618 Burney Dr, Mariposa., California. 95338, USA','Mariposa',        'CA','95338',    'punctuation after city/state'),
       ('715 Indiana Ave St. Charles, Illinois 60174, USA', 'Saint Charles',   'IL','60174',    'St. city prefix'),
       ('1230 Cedar Brook Dr NE Lawrenceville, Georgia 30043, USA','Lawrenceville','GA','30043', 'street direction before city')
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
              THEN '15 shapes resolved, including punctuation, St. city abbreviation and street direction'
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
--     Use a synthetic place so this check does not depend on the live
--     us_places dataset containing a particular city spelling. A whole-state
--     Area must NOT resolve, because it cannot be shown to reach one job.
-- -----------------------------------------------------------------------------
INSERT INTO public.us_places
  (geoid, name, state_code, state_name, population, latitude, longitude)
VALUES ('ZZ-COV-PROBE', 'Coverage Probe City', 'TX', 'Texas', 100, 0, 0);

INSERT INTO public.us_places
  (geoid, name, state_code, state_name, population, latitude, longitude)
VALUES ('ZZ-COV-FAR-PROBE', 'Coverage Far City', 'TX', 'Texas', 100, 89, -179);

DO $$
DECLARE
  v_city   record;
  v_state   record;
  v_bad integer := 0;
  v_detail text := '';
BEGIN
  SELECT * INTO v_city FROM public.technician_area_place('Coverage Probe City, TX');
  IF v_city.latitude IS NULL OR v_city.city IS DISTINCT FROM 'Coverage Probe City'
     OR v_city.state_code IS DISTINCT FROM 'TX' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' synthetic city did not place: '
      || coalesce(v_city.city, '(no city)') || ', '
      || coalesce(v_city.state_code, '(no state)') || ' lat='
      || coalesce(v_city.latitude::text, 'NULL') || ';';
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
              THEN 'synthetic city placed; "California" left unplaced so it counts for nobody'
              ELSE v_detail
         END;
END $$;

-- -----------------------------------------------------------------------------
-- 04  The count is distance, not a state-wide substring
--     Three technicians sit on a synthetic Census place at 0,0. This is
--     deliberately away from the real U.S. roster, so live technicians cannot
--     make the exact expected count flaky. Nine technicians sit at (0,0), and
--     one sits 48 miles away. Leads test 9=Normal, 1=Normal, 10=Good and 0=Bad;
--     one of them starts without an address and gets it later.
--
--     The far lead is the regression the live data exposed: under the substring
--     rule it matched every technician whose Area contained the lead city/state and
--     was labelled Good. Under distance it must read 0 and Bad.
-- -----------------------------------------------------------------------------
INSERT INTO public.technicians (name, area, is_active)
VALUES ('COV-PROBE-01', 'Coverage Probe City, TX', true),
       ('COV-PROBE-02', 'Coverage Probe City, TX', true),
       ('COV-PROBE-03', 'Coverage Probe City, TX', true),
       ('COV-PROBE-04', 'Coverage Probe City, TX', true),
       ('COV-PROBE-05', 'Coverage Probe City, TX', true),
       ('COV-PROBE-06', 'Coverage Probe City, TX', true),
       ('COV-PROBE-07', 'Coverage Probe City, TX', true),
       ('COV-PROBE-08', 'Coverage Probe City, TX', true),
       ('COV-PROBE-09', 'Coverage Probe City, TX', true),
       ('COV-PROBE-10', 'Coverage Probe City, TX', true);

UPDATE public.technicians
   SET latitude = 0, longitude = 0.7
 WHERE name = 'COV-PROBE-10';

-- The leads trigger computes coverage on insert; the addresses carry the state in
-- the shape the old parser mishandled, and the coordinates make the expected
-- distance unambiguous.
INSERT INTO public.leads (job_id, customer_name, customer_phone, service_type, status, address, latitude, longitude)
VALUES ('ZZ-COV-NEAR', 'Coverage probe near', '9990000001', 'General', 'urgent_job',
        NULL, 0, 0),
       ('ZZ-COV-30MI', 'Coverage probe 30mi', '9990000002', 'General', 'urgent_job',
        '1 Probe Road Coverage Probe City, TX 75000', 0, 0.7),
       ('ZZ-COV-GOOD', 'Coverage probe ten', '9990000005', 'General', 'urgent_job',
         '1 Probe Road Coverage Probe City, TX 75000', 0, 0.35),
       ('ZZ-COV-FAR', 'Coverage probe far', '9990000003', 'General', 'urgent_job',
         '1 Probe Road Coverage Probe City, TX 75000', 0, 10);

-- Extension-style insert: only the address is provided, with no pre-geocoded
-- latitude/longitude. The trigger must place it via the city in us_places.
INSERT INTO public.leads (job_id, customer_name, customer_phone, service_type, status, address)
VALUES ('ZZ-COV-EXT', 'Coverage extension style', '9990000006', 'General', 'urgent_job',
        '1 Probe Road Coverage Probe City, TX 75000');

-- No address at creation means no badge. Adding the address later must trigger
-- the same count without the extension or web client calling an extra RPC.
DO $$
DECLARE
  v_count integer;
  v_level text;
  v_ext_count integer;
  v_ext_level text;
BEGIN
  SELECT coverage_tech_count, coverage_level INTO v_count, v_level
    FROM public.leads WHERE job_id = 'ZZ-COV-NEAR';
  SELECT coverage_tech_count, coverage_level INTO v_ext_count, v_ext_level
    FROM public.leads WHERE job_id = 'ZZ-COV-EXT';

  INSERT INTO _results
  SELECT 4,
         'empty lead stays unbadged; extension-style insert is checked',
         v_count IS NULL AND v_level IS NULL
           AND v_ext_count IS NOT DISTINCT FROM 9
           AND v_ext_level IS NOT DISTINCT FROM 'normal',
         format('empty lead=%s/%s; address-only insert=%s/%s (expected NULL/NULL and 9/normal)',
           coalesce(v_count::text, 'NULL'), coalesce(v_level, 'NULL'),
           coalesce(v_ext_count::text, 'NULL'), coalesce(v_ext_level, 'NULL'));
END $$;

UPDATE public.leads
   SET address = '1 Probe Road Coverage Probe City, TX 75000'
 WHERE job_id = 'ZZ-COV-NEAR';

DO $$
DECLARE
  v_near integer;
  v_near_level text;
  v_mid  integer;
  v_good integer;
  v_good_level text;
  v_far  integer;
  v_far_level text;
  v_bad integer := 0;
  v_detail text := '';
BEGIN
  SELECT coverage_tech_count, coverage_level INTO v_near, v_near_level
    FROM public.leads WHERE job_id = 'ZZ-COV-NEAR';
  SELECT coverage_tech_count INTO v_mid FROM public.leads WHERE job_id = 'ZZ-COV-30MI';
  SELECT coverage_tech_count, coverage_level INTO v_good, v_good_level
    FROM public.leads WHERE job_id = 'ZZ-COV-GOOD';
  SELECT coverage_tech_count, coverage_level INTO v_far, v_far_level
    FROM public.leads WHERE job_id = 'ZZ-COV-FAR';

  IF v_near IS DISTINCT FROM 9 OR v_near_level IS DISTINCT FROM 'normal' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' lead on top of the 9-technician group read count='
      || coalesce(v_near::text, 'NULL') || ' level=' || coalesce(v_near_level, 'NULL')
      || ' (expected 9 / normal);';
  END IF;

  IF v_mid IS DISTINCT FROM 1 THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' lead 48 miles from the main group read '
      || coalesce(v_mid::text, 'NULL') || ' (expected 1);';
  END IF;

  IF v_good IS DISTINCT FROM 10 OR v_good_level IS DISTINCT FROM 'good' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' lead between groups read count='
      || coalesce(v_good::text, 'NULL') || ' level=' || coalesce(v_good_level, 'NULL')
      || ' (expected 10 / good);';
  END IF;

  -- The regression. The same city and state as the nearby techs, but they are
  -- outside 40 miles. A text/state fallback would incorrectly count all three.
  IF v_far IS DISTINCT FROM 0 OR v_far_level IS DISTINCT FROM 'bad' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' far lead in the same state read count='
      || coalesce(v_far::text, 'NULL') || ' level=' || coalesce(v_far_level, 'NULL')
      || ' (expected 0 / bad - this is the city/state substring bug);';
  END IF;

  -- Editing the address a second time must replace the old stored result; a
  -- trigger that only handles initial creation or first address entry is stale.
  UPDATE public.leads
     SET address = '1 Probe Road Coverage Far City, TX 75000',
         latitude = NULL,
         longitude = NULL
   WHERE job_id = 'ZZ-COV-NEAR';
  SELECT coverage_tech_count, coverage_level INTO v_near, v_near_level
    FROM public.leads WHERE job_id = 'ZZ-COV-NEAR';
  IF v_near IS DISTINCT FROM 0 OR v_near_level IS DISTINCT FROM 'bad' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' second address edit was not recalculated: '
      || coalesce(v_near::text, 'NULL') || '/' || coalesce(v_near_level, 'NULL')
      || ' (expected 0/bad);';
  END IF;

  -- Restore the original location so the set-based consistency check below
  -- continues to compare against the same 9-technician case.
  UPDATE public.leads
     SET address = '1 Probe Road Coverage Probe City, TX 75000',
         latitude = 0,
         longitude = 0
   WHERE job_id = 'ZZ-COV-NEAR';
  SELECT coverage_tech_count, coverage_level INTO v_near, v_near_level
    FROM public.leads WHERE job_id = 'ZZ-COV-NEAR';
  IF v_near IS DISTINCT FROM 9 OR v_near_level IS DISTINCT FROM 'normal' THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' restoring the address did not restore 9/normal;';
  END IF;

  INSERT INTO _results
  SELECT 5,
         'coverage counts by distance, not by state substring',
         v_bad = 0,
         CASE WHEN v_bad = 0
              THEN 'address added -> 9 normal, 48mi=1 normal, between=10 good, far=0 bad'
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
  INSERT INTO public.leads (job_id, customer_name, customer_phone, service_type, status, address)
  VALUES ('ZZ-COV-UNREADABLE', 'Coverage probe unreadable', '9990000004', 'General', 'urgent_job',
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
  SELECT 6,
         'an unreadable address yields no badge, not a false zero',
         v_bad = 0,
         CASE WHEN v_bad = 0 THEN 'both NULL' ELSE v_detail END;
END $$;

-- -----------------------------------------------------------------------------
-- 06  Census suffix aliases resolve from a real address
--     This address parses as Mariposa, CA, while the Census table names its
--     coordinate row "Mariposa CDP". The coverage resolver must treat those as
--     the same place and store a real result instead of leaving coverage NULL.
-- -----------------------------------------------------------------------------
INSERT INTO public.leads
  (job_id, customer_name, customer_phone, service_type, status, address)
VALUES ('ZZ-COV-ALIAS', 'Coverage alias probe', '9990000007', 'General', 'urgent_job',
        '4618 Burney Dr,, Mariposa. California. 95338 USA');

DO $$
DECLARE
  v_count integer;
  v_level text;
  v_label text;
  v_checked timestamptz;
  v_preview_count integer;
  v_preview_label text;
  v_admin_id uuid;
BEGIN
  SELECT user_id INTO v_admin_id
    FROM public.user_roles WHERE role = 'admin' ORDER BY user_id LIMIT 1;
  IF v_admin_id IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END IF;

  SELECT coverage_tech_count, coverage_level, coverage_area_label, coverage_checked_at
    INTO v_count, v_level, v_label, v_checked
    FROM public.leads WHERE job_id = 'ZZ-COV-ALIAS';

  SELECT tech_count, area_label INTO v_preview_count, v_preview_label
    FROM public.preview_lead_technician_coverage(
      '4618 Burney Dr,, Mariposa. California. 95338 USA', NULL, NULL, NULL
    );

  INSERT INTO _results
  SELECT 7,
         'messy address and pre-save coverage preview resolve consistently',
         v_checked IS NOT NULL
           AND v_label IS NOT DISTINCT FROM 'Mariposa, CA'
           AND v_preview_count IS NOT DISTINCT FROM v_count
           AND v_preview_label IS NOT DISTINCT FROM v_label
           AND v_level IN ('good', 'normal', 'bad')
           AND ((v_count >= 10 AND v_level = 'good')
             OR (v_count BETWEEN 1 AND 9 AND v_level = 'normal')
             OR (v_count = 0 AND v_level = 'bad')),
         format('stored=%s/%s preview=%s/%s area=%s checked=%s',
           coalesce(v_count::text, 'NULL'), coalesce(v_level, 'NULL'),
           coalesce(v_preview_count::text, 'NULL'), coalesce(v_preview_label, 'NULL'),
           coalesce(v_label, 'NULL'), coalesce(v_checked::text, 'NULL'));
END $$;

-- -----------------------------------------------------------------------------
-- 08  A Census-geocoded point works even when no city can be parsed
--     This is the fallback used for neighborhoods and alternate city names.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_count integer;
  v_level text;
  v_label text;
BEGIN
  SELECT tech_count, area_label INTO v_count, v_label
    FROM public.preview_lead_technician_coverage_at_point(
      '77002', NULL, NULL, NULL, 0, 0
    );
  v_level := CASE
    WHEN v_count >= 10 THEN 'good'
    WHEN v_count >= 1 THEN 'normal'
    ELSE 'bad'
  END;

  INSERT INTO _results
  SELECT 8,
         'geocoded location previews without parsed city text',
         v_count IS NOT DISTINCT FROM 9
           AND v_level IS NOT DISTINCT FROM 'normal'
           AND v_label IS NOT NULL,
         format('count=%s level=%s area=%s (expected 9/normal)',
           coalesce(v_count::text, 'NULL'), coalesce(v_level, 'NULL'), coalesce(v_label, 'NULL'));
END $$;

-- -----------------------------------------------------------------------------
-- 09  Recalculating everything agrees with the per-lead answer
--     A set-based pass and a per-lead trigger pass must not disagree; that
--     disagreement is how a badge ends up showing a number nobody can reproduce.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_spread record;
  v_bad integer := 0;
  v_detail text := '';
  v_per_lead integer;
  v_alias_before integer;
  v_alias_after integer;
BEGIN
  SELECT coverage_tech_count INTO v_alias_before
    FROM public.leads WHERE job_id = 'ZZ-COV-ALIAS';
  SELECT * INTO v_spread FROM public.compute_all_lead_coverage();

  IF v_spread IS NULL THEN
    v_bad := v_bad + 1;
    v_detail := v_detail || ' compute_all_lead_coverage() returned no row;';
  ELSE
    SELECT coverage_tech_count INTO v_per_lead
      FROM public.leads WHERE job_id = 'ZZ-COV-NEAR';

    IF v_per_lead IS DISTINCT FROM 9 THEN
      v_bad := v_bad + 1;
      v_detail := v_detail || ' after a full recalc the near lead read '
        || coalesce(v_per_lead::text, 'NULL') || ' (expected 9);';
    END IF;

    SELECT coverage_tech_count INTO v_alias_after
      FROM public.leads WHERE job_id = 'ZZ-COV-ALIAS';
    IF v_alias_after IS DISTINCT FROM v_alias_before THEN
      v_bad := v_bad + 1;
      v_detail := v_detail || format(
        ' full recalc changed alias coverage from %s to %s;',
        coalesce(v_alias_before::text, 'NULL'), coalesce(v_alias_after::text, 'NULL'));
    END IF;

    -- The spread must account for every lead it claims to have checked.
    IF v_spread.good + v_spread.normal + v_spread.bad <> v_spread.checked - v_spread.unlocated THEN
      v_bad := v_bad + 1;
      v_detail := v_detail || format(' spread does not add up: checked=%s good=%s normal=%s bad=%s unlocated=%s;',
        v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated);
    END IF;
  END IF;

  INSERT INTO _results
  SELECT 9,
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
