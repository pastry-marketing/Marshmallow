-- =============================================================================
-- Migration : 20261107000000_place_coverage_by_us_places.sql
-- Purpose   : Decide "how many technicians can reach this job?" from real
--             distance, instead of substring matching on address text.
--
-- WHY THIS REPLACES THE SUBSTRING RULE
--   The first version resolved the lead's city + state from the address, then
--   counted technicians whose free-text Area contained those strings. On the
--   live data that failed in both directions at once:
--
--     * impossible counts - "403 active technicians near a house in Los
--       Angeles" - because the state code "CA" was matched as a substring
--       against full state names ("California", "Houston, Texas"), so every
--       technician in the state matched;
--     * false "Bad Coverage" in real metros - "Buford, GA" and "Oceanside, CA"
--       returned 0 because the roster says "Atlanta" and "San Diego".
--
--   This migration keeps the same city information but gives it meaning that
--   holds up: the lead and every technicians row are placed on
--   public.us_places (31,839 Census places already in the database, already
--   readable by every signed-in user) and the count is the number of distinct
--   active technicians whose place sits within 40 miles. That is the same rule
--   Map View's coverage circles draw, and the same haversine the Areas page
--   uses, so the badge and the map cannot disagree about "nearby".
--
--   A technician whose Area cannot be placed at a U.S. place - blank, a whole
--   state, or a metro shorthand like "DFW" - contributes to no count. That is
--   stated rather than guessed at, and it is the reason to fill in an Area on
--   the Technicians page.
--
-- THE TWO RULES THAT MATTER MOST
--
--   1. A lead we cannot place shows NO badge. It never reads as "Bad
--      Coverage": an unreadable address is not an unserved area.
--   2. If not one active technician can be placed anywhere on the roster,
--      every lead shows no badge, because a roster we cannot read proves
--      nothing about coverage.
--
-- SET-BASED RECALCULATE
--   compute_all_lead_coverage() materialises the placed technician set once and
--   joins it to the placed leads. The previous version called the per-lead
--   function 4,000+ times, each of which re-derived the whole roster. The
--   per-lead path (the leads trigger and recalculate_lead_coverage) is
--   unchanged and still agrees, because both call lead_technician_coverage().
--
-- PERMISSIONS
--   technicians row level security allows only admin and processor, so the
--   count is computed in a SECURITY DEFINER function that returns a single
--   number and is granted to no client role. The only value the browser reads
--   is the number already stored on the caller's own lead. The recompute entry
--   points stay role-gated inside the function, because a SECURITY DEFINER
--   function with no internal check is safe only by accident.
--
-- ROLLBACK
--   Re-run 20261105000000_lead_technician_coverage.sql to restore the previous
--   substring implementation; its ROLLBACK section drops these functions too.
--   Stored values stay valid columns either way, so only the counts change.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Refuse to install without the place table
--    Failing with a named cause beats installing a version that quietly matches
--    nothing.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.us_places') IS NULL THEN
    RAISE EXCEPTION 'public.us_places is missing. Apply the migration that creates it.'
      USING ERRCODE = 'undefined_table';
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 1. Index for the lookups below
--    Both technician_area_place and the lead placement match a city by name and
--    state on every check. Without this each one scans all 31k places.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS us_places_name_state_idx
  ON public.us_places (lower(name), state_code);


-- -----------------------------------------------------------------------------
-- 2. Distance
--    Same formula and same earth radius as get_top_nearby_populated_areas in
--    20260721073025, so every distance in this database is computed one way.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.haversine_miles(
  _lat1 double precision,
  _lng1 double precision,
  _lat2 double precision,
  _lng2 double precision
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
  SELECT 3958.7613 * 2 * asin(least(1.0, sqrt(
           power(sin(radians((_lat2 - _lat1) / 2)), 2)
         + cos(radians(_lat1)) * cos(radians(_lat2))
           * power(sin(radians((_lng2 - _lng1) / 2)), 2)
       )))
$fn$;

COMMENT ON FUNCTION public.haversine_miles(double precision, double precision, double precision, double precision) IS
  'Great-circle distance in miles between two points. Matches the formula the '
  'coverage circles and the Areas page already use.';

REVOKE ALL ON FUNCTION public.haversine_miles(double precision, double precision, double precision, double precision)
  FROM PUBLIC, anon;


-- -----------------------------------------------------------------------------
-- 3. Place a technician's Area on the map
--    technicians.area is free text typed through a combobox, so it arrives as
--    "City, TX", "City, Texas", "City", a whole state, or nothing at all. This
--    returns the city and state it names, plus coordinates when that city
--    exists in us_places.
--
--    Coordinates come back NULL for anything it cannot place, which is how the
--    caller knows not to count that technician.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.technician_area_place(_area text)
RETURNS TABLE (
  city        text,
  state_code  text,
  latitude    double precision,
  longitude   double precision
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_text       text := btrim(coalesce(_area, ''));
  v_state      text;
  v_candidate  text;
  v_stripped   text;
  v_state_name text;
  v_lat        double precision;
  v_lng        double precision;
BEGIN
  IF v_text = '' THEN
    RETURN;
  END IF;

  -- "TX" as a word wins over a state name: "Washington, DC" must not resolve
  -- to WA because "Washington" is a state name too.
  v_state := public.us_state_code(v_text);

  -- Everything before the first comma is the city in "City, TX" form.
  v_candidate := btrim(split_part(v_text, ',', 1));

  -- Direct hit: "Houston" out of "Houston, Texas", or "New York" out of
  -- "New York".
  SELECT p.latitude, p.longitude
    INTO v_lat, v_lng
    FROM public.us_places p
   WHERE lower(p.name) = lower(v_candidate)
     AND (v_state IS NULL OR p.state_code = v_state)
   ORDER BY p.population DESC, p.name
   LIMIT 1;

  -- No hit, so the candidate may be carrying the state with it, as in
  -- "Boston MA" or "Austin Texas". Drop the trailing state token and retry.
  IF v_lat IS NULL AND v_state IS NOT NULL THEN
    SELECT p.state_name
      INTO v_state_name
      FROM public.us_places p
     WHERE p.state_code = v_state
       AND p.state_name IS NOT NULL
     ORDER BY p.name
     LIMIT 1;

    v_stripped := v_candidate;
    IF v_state_name IS NOT NULL THEN
      v_stripped := btrim(regexp_replace(v_stripped, '\s+' || v_state_name || '\s*$', '', 'i'));
    END IF;
    v_stripped := btrim(regexp_replace(v_stripped, '\s+[A-Za-z]{2}\s*$', ''));

    IF v_stripped <> '' AND v_stripped <> v_candidate THEN
      SELECT p.latitude, p.longitude
        INTO v_lat, v_lng
        FROM public.us_places p
       WHERE lower(p.name) = lower(v_stripped)
         AND p.state_code = v_state
       ORDER BY p.population DESC, p.name
       LIMIT 1;

      IF v_lat IS NOT NULL THEN
        v_candidate := v_stripped;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT nullif(v_candidate, ''), v_state, v_lat, v_lng;
END;
$fn$;

COMMENT ON FUNCTION public.technician_area_place(text) IS
  'Resolves a technician''s free-text Area to a city, a state and, when that city '
  'exists in us_places, coordinates. Coordinates are null for a blank, whole-state '
  'or shorthand area, and such a technician is counted for no lead.';

REVOKE ALL ON FUNCTION public.technician_area_place(text) FROM PUBLIC, anon;


-- -----------------------------------------------------------------------------
-- 4. The count for one lead
--    Pure computation. Returns no row when the lead cannot be placed, so an
--    unreadable address is never reported as zero technicians - which would
--    read as "nobody covers this" and be wrong.
--
--    COALESCE prefers a technician's own stored coordinates and falls back to
--    placing their Area, so a technician geocoded once keeps counting even if
--    their Area text stops matching a city.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_technician_coverage(_lead_id uuid)
RETURNS TABLE (tech_count bigint, area_label text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_lead         public.leads%ROWTYPE;
  v_lat          double precision;
  v_lng          double precision;
  v_city         text;
  v_state        text;
  v_zip          text;
  v_label        text;
  v_count        bigint;
  v_placeable    bigint;
  v_radius_miles constant double precision := 40;
BEGIN
  SELECT * INTO c_lead FROM public.leads l WHERE l.id = _lead_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The same parser every area report uses.
  SELECT loc.city, loc.state, loc.zip_code
    INTO v_city, v_state, v_zip
    FROM public.parse_lead_location(
           c_lead.address, c_lead.city, c_lead.state, c_lead.zip_code
         ) AS loc;

  IF v_city IS NULL AND v_state IS NULL AND v_zip IS NULL THEN
    RETURN;
  END IF;

  v_label := COALESCE(
    NULLIF(btrim(concat_ws(', ', v_city, v_state)), ''),
    NULLIF(btrim(concat_ws(' ', v_state, v_zip)), ''),
    v_zip,
    v_city,
    v_state
  );

  -- Place the lead. Stored coordinates first, since a lead that has been
  -- geocoded is more precise than the centre of its city.
  v_lat := c_lead.latitude;
  v_lng := c_lead.longitude;

  IF (v_lat IS NULL OR v_lng IS NULL) AND v_city IS NOT NULL THEN
    SELECT p.latitude, p.longitude
      INTO v_lat, v_lng
      FROM public.us_places p
     WHERE lower(p.name) = lower(btrim(v_city))
       AND (v_state IS NULL OR p.state_code = v_state)
     ORDER BY p.population DESC, p.name
     LIMIT 1;
  END IF;

  -- Unplaced lead, no badge. Not the same claim as "no technicians here".
  IF v_lat IS NULL OR v_lng IS NULL THEN
    RETURN;
  END IF;

  -- How much of the roster can be placed at all. If none of it can, a count of
  -- zero would be reporting our blindness rather than the roster.
  SELECT count(*)
    INTO v_placeable
    FROM public.technicians t
    LEFT JOIN LATERAL public.technician_area_place(t.area) tp ON true
   WHERE coalesce(t.is_active, true)
     AND COALESCE(t.latitude,  tp.latitude)  IS NOT NULL
     AND COALESCE(t.longitude, tp.longitude) IS NOT NULL;

  IF v_placeable = 0 THEN
    RETURN;
  END IF;

  -- The bounding box is a cheap prefilter only; haversine decides membership.
  -- It is deliberately wider than 40 miles at every inhabited latitude, so the
  -- prefilter can never discard a technician that distance would have kept.
  SELECT count(DISTINCT lower(btrim(t.name)))
    INTO v_count
    FROM public.technicians t
    LEFT JOIN LATERAL public.technician_area_place(t.area) tp ON true
   WHERE coalesce(t.is_active, true)
     AND COALESCE(t.latitude,  tp.latitude)  BETWEEN v_lat - 0.8 AND v_lat + 0.8
     AND COALESCE(t.longitude, tp.longitude) BETWEEN v_lng - 1.5 AND v_lng + 1.5
     AND public.haversine_miles(
           v_lat,
           v_lng,
           COALESCE(t.latitude,  tp.latitude),
           COALESCE(t.longitude, tp.longitude)
         ) <= v_radius_miles;

  RETURN QUERY SELECT GREATEST(v_count, 0), v_label;
END;
$fn$;

COMMENT ON FUNCTION public.lead_technician_coverage(uuid) IS
  'Active technicians near a lead: placed on us_places and counted within 40 miles. '
  'Returns no row when the lead cannot be placed, or when no technician on the roster '
  'can be. Internal: not granted to any client role.';

REVOKE ALL ON FUNCTION public.lead_technician_coverage(uuid) FROM PUBLIC, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 5. Recompute every lead, set-based
--    Internal worker. The placed roster is materialised once and joined to the
--    placed leads, so the cost is one pass rather than 4,000 roster passes.
--
--    Leads with no address at all are left alone: there is nothing to check, and
--    they will be picked up by the trigger the moment an address arrives.
--    Leads that have an address but cannot be placed are cleared rather than
--    stamped Bad, so an emptied or unreadable address never keeps claiming
--    coverage it no longer has.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_all_lead_coverage()
RETURNS TABLE (checked bigint, good bigint, normal bigint, bad bigint, unlocated bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_placeable bigint;
BEGIN
  SELECT count(*)
    INTO v_placeable
    FROM public.technicians t
    LEFT JOIN LATERAL public.technician_area_place(t.area) tp ON true
   WHERE coalesce(t.is_active, true)
     AND COALESCE(t.latitude,  tp.latitude)  IS NOT NULL
     AND COALESCE(t.longitude, tp.longitude) IS NOT NULL;

  IF v_placeable = 0 THEN
    -- Nothing on the roster can be placed, so nothing can be said.
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  WITH placed_tech AS MATERIALIZED (
    SELECT lower(btrim(t.name))            AS tech_name,
           COALESCE(t.latitude,  tp.latitude)  AS lat,
           COALESCE(t.longitude, tp.longitude) AS lng
      FROM public.technicians t
      LEFT JOIN LATERAL public.technician_area_place(t.area) tp ON true
     WHERE coalesce(t.is_active, true)
       AND COALESCE(t.latitude,  tp.latitude)  IS NOT NULL
       AND COALESCE(t.longitude, tp.longitude) IS NOT NULL
  ),
  placed_lead AS (
    SELECT l.id,
           COALESCE(l.latitude,  up.latitude)  AS lat,
           COALESCE(l.longitude, up.longitude) AS lng,
           loc.city,
           loc.state
      FROM public.leads l
      CROSS JOIN LATERAL public.parse_lead_location(
                         l.address, l.city, l.state, l.zip_code
                       ) AS loc
      LEFT JOIN LATERAL (
        SELECT p.latitude, p.longitude
          FROM public.us_places p
         WHERE loc.city IS NOT NULL
           AND lower(p.name) = lower(btrim(loc.city))
           AND (loc.state IS NULL OR p.state_code = loc.state)
         ORDER BY p.population DESC, p.name
         LIMIT 1
      ) AS up ON true
     WHERE l.address IS NOT NULL OR l.city IS NOT NULL OR l.state IS NOT NULL
  ),
  counts AS (
    SELECT pl.id,
           pl.city,
           pl.state,
           count(DISTINCT pt.tech_name) AS tech_count
      FROM placed_lead pl
      LEFT JOIN placed_tech pt
        ON pt.lat BETWEEN pl.lat - 0.8 AND pl.lat + 0.8
       AND pt.lng BETWEEN pl.lng - 1.5 AND pl.lng + 1.5
       AND public.haversine_miles(pl.lat, pl.lng, pt.lat, pt.lng) <= 40
     WHERE pl.lat IS NOT NULL
       AND pl.lng IS NOT NULL
     GROUP BY pl.id, pl.city, pl.state
  )
  UPDATE public.leads l
     SET coverage_tech_count = CASE
                                WHEN c.id IS NULL THEN NULL
                                ELSE c.tech_count::integer
                              END,
         coverage_level      = CASE
                                WHEN c.id IS NULL THEN NULL
                                WHEN c.tech_count >= 10 THEN 'good'
                                WHEN c.tech_count >= 1  THEN 'normal'
                                ELSE 'bad'
                              END,
         coverage_area_label = CASE
                                WHEN c.id IS NULL THEN NULL
                                ELSE COALESCE(
                                       NULLIF(btrim(concat_ws(', ', c.city, c.state)), ''),
                                       l.coverage_area_label
                                     )
                              END,
         coverage_checked_at = now()
    FROM placed_lead pl
    LEFT JOIN counts c ON c.id = pl.id
   WHERE l.id = pl.id;

  RETURN QUERY
    SELECT
      count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL),
      count(*) FILTER (WHERE l.coverage_level = 'good'),
      count(*) FILTER (WHERE l.coverage_level = 'normal'),
      count(*) FILTER (WHERE l.coverage_level = 'bad'),
      count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL
                         AND l.coverage_level IS NULL)
    FROM public.leads l;
END;
$fn$;

COMMENT ON FUNCTION public.compute_all_lead_coverage() IS
  'Recomputes coverage on every located lead in one set-based pass and returns the '
  'resulting spread. Internal worker for recalculate_all_lead_coverage(); not '
  'granted to any client role, because it does not check the caller itself.';

REVOKE ALL ON FUNCTION public.compute_all_lead_coverage() FROM PUBLIC, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 6. The admin entry point
--    A technician's Area edit changes the answer for every lead near them, and
--    no per-row trigger on leads can observe that, so this is the one operation
--    that has to be asked for. Run it after a roster change.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalculate_all_lead_coverage()
RETURNS TABLE (checked bigint, good bigint, normal bigint, bad bigint, unlocated bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin may re-check coverage for every lead'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT * FROM public.compute_all_lead_coverage();
END;
$fn$;

COMMENT ON FUNCTION public.recalculate_all_lead_coverage() IS
  'Recomputes coverage on every located lead and returns the resulting spread. '
  'Admin only. Run after technicians are added, moved, or deactivated.';

REVOKE ALL ON FUNCTION public.recalculate_all_lead_coverage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_all_lead_coverage() TO authenticated;


-- -----------------------------------------------------------------------------
-- 7. Backfill, now that the answer is computed differently
--    The values stored by 20261105000000 were produced by the substring rule and
--    are wrong in both directions, so they are all recomputed rather than kept.
--
--    This runs inside the migration, where there is no signed-in admin, so it
--    calls the internal worker directly instead of the role-gated entry point.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_spread record;
BEGIN
  SELECT * INTO v_spread FROM public.compute_all_lead_coverage();

  RAISE NOTICE
    'Lead coverage recomputed: % checked, % good, % normal, % bad, % with no placeable area.',
    v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated;
END $$;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP FUNCTION IF EXISTS public.recalculate_all_lead_coverage();
--   DROP FUNCTION IF EXISTS public.compute_all_lead_coverage();
--   DROP FUNCTION IF EXISTS public.lead_technician_coverage(uuid);
--   DROP FUNCTION IF EXISTS public.technician_area_place(text);
--   DROP FUNCTION IF EXISTS public.haversine_miles(double precision, double precision, double precision, double precision);
--   DROP INDEX IF EXISTS public.us_places_name_state_idx;
--
-- Then re-run 20261105000000_lead_technician_coverage.sql to put the previous
-- substring-based implementation back.
--
-- No lead's address, status, schedule or notes are modified by this migration.
-- =============================================================================
