-- =============================================================================
-- Migration : 20261030180000_area_leaderboard_and_location_cleanup.sql
-- Purpose   : Give the Optimization section one job - decide and track which
--             areas to push - by ranking areas on the jobs that closed in
--             them, and stop an invisible character leaking into labels.
--
-- WHY A LEADERBOARD
--   The Optimisation page was showing the technician report and a rollup
--   grouped by state and zip. Neither helped. The technician table belongs on
--   the Technicians page where it already exists, and a state-and-zip rollup
--   is too fine to decide on: most rows contain a single technician, which
--   says nothing about whether an area is worth pushing.
--
--   Measured against live data, concentration is at state level - CA 92
--   closed, TX 68, FL 48, GA 32 - while the busiest single zip carries 3.
--   So the leaderboard ranks by state, which is the grain the evidence is
--   meaningful at, and shows whether each state is already marked.
--
--   This is the same denominator used everywhere else: only leads that
--   reached a technician, so an area is not judged on work never staffed.
--
-- BUG THIS ALSO FIXES
--   One location label rendered as
--     "3608 W Olivia Dr Wylie, TX 75098, USA" followed by an invisible
--     character, because the stored address contains a stray U+FEFF byte
--   order mark and the cleaner stripped trailing spaces and punctuation but
--   not invisible characters. Anything invisible is now removed from the
--   address before it is parsed, so it cannot reach a label, a group key or
--   an export.
--
-- PERMISSIONS
--   Admin only, matching the Optimization section.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Location resolution: drop invisible characters from the address
--    Redefining this also moves every report onto the cleaned definition at
--    once, since they all call it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.parse_lead_location(
  _address text,
  _city    text,
  _state   text,
  _zip     text
)
RETURNS TABLE (city text, state text, zip_code text)
LANGUAGE sql
IMMUTABLE
AS $fn$
  WITH stripped AS (
    -- Remove anything invisible before anything else: a byte order mark or a
    -- zero-width space in the address would otherwise survive to the end of
    -- the string and defeat the end-anchored zip and state patterns, and show
    -- up in a label as a character nobody can see.
    SELECT btrim(regexp_replace(coalesce(_address, ''), '[\u200B-\u200D\uFEFF\u00AD\u2060]', '', 'g')) AS a
  ),
  cleaned AS (
    SELECT btrim(regexp_replace(
             regexp_replace(
               a,
               '\s*,?\s*(USA|U\.S\.A\.|United States|US)\s*[,.]?\s*$',
               '',
               'i'
             ),
             '[\s,.]+$',
             ''
           )) AS a
    FROM stripped
  ),
  parsed AS (
    SELECT
      c.a,
      nullif((regexp_match(c.a, '([0-9]{5})(?:[- ][0-9]{4})?\s*$'))[1], '') AS p_zip,
      CASE
        WHEN upper(nullif((regexp_match(c.a, '([A-Za-z]{2})\s+[0-9]{5}(?:[- ][0-9]{4})?\s*$'))[1], ''))
             IN ('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                 'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                 'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                 'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                 'WI','WY','DC')
          THEN upper(nullif((regexp_match(c.a, '([A-Za-z]{2})\s+[0-9]{5}(?:[- ][0-9]{4})?\s*$'))[1], ''))
      END AS p_state,
      CASE
        WHEN nullif(btrim((regexp_match(c.a, '([^,]+),\s*([A-Za-z]{2})\s+[0-9]{5}'))[1]), '')
             ~ '[0-9#]' IS TRUE
          THEN NULL
        WHEN lower(nullif(btrim((regexp_match(c.a, '([^,]+),\s*([A-Za-z]{2})\s+[0-9]{5}'))[1]), ''))
             ~ '(^|\s)(st|street|ave|avenue|av|dr|drive|ln|lane|ct|court|blvd|boulevard|bl|way|rd|road|pkwy|parkway|pky|ter|terrace|trl|trail|cir|circle|pl|place|sq|square|hwy|highway|expy|fwy|loop|path|row|pt|point|plz|plaza)\.?$'
          THEN NULL
        ELSE nullif(btrim((regexp_match(c.a, '([^,]+),\s*([A-Za-z]{2})\s+[0-9]{5}'))[1]), '')
      END AS p_city
    FROM cleaned c
  )
  SELECT
    CASE
      WHEN nullif(btrim(coalesce(_city, '')), '')  IS NOT NULL
        THEN btrim(_city)
      ELSE p.p_city
    END,
    CASE
      WHEN upper(coalesce(btrim(coalesce(_state, '')), '')) ~ '^[A-Z]{2}$'
        THEN upper(btrim(_state))
      ELSE p.p_state
    END,
    CASE
      WHEN btrim(coalesce(_zip, '')) ~ '^[0-9]{5}(-[0-9]{4})?$'
        THEN btrim(_zip)
      ELSE p.p_zip
    END
  FROM parsed p;
$fn$;


-- -----------------------------------------------------------------------------
-- 2. Area leaderboard, ranked on jobs closed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.area_leaderboard(_limit int DEFAULT 25)
RETURNS TABLE (
  state           text,
  cities          text,
  technicians     bigint,
  closed_count    bigint,
  cancelled_count bigint,
  scheduled_count bigint,
  closed_rate_pct numeric,
  is_optimised    boolean,
  last_closed_at  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only admins may read the area leaderboard'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT
      l.status,
      l.created_at,
      lower(btrim(l.tech_name)) AS tech_key,
      loc.city                   AS r_city,
      loc.state                  AS r_state
    FROM public.leads l
    CROSS JOIN LATERAL public.parse_lead_location(
      l.address, l.city, l.state, l.zip_code
    ) AS loc
    WHERE l.status IN ('paid', 'cancelled', 'scheduled')
      AND coalesce(btrim(l.tech_name), '') <> ''
  ),
  by_state AS (
    SELECT
      s.r_state,
      count(DISTINCT s.tech_key) AS technicians,
      count(*) FILTER (WHERE s.status = 'paid')      AS closed_count,
      count(*) FILTER (WHERE s.status = 'cancelled') AS cancelled_count,
      count(*) FILTER (WHERE s.status = 'scheduled') AS scheduled_count,
      max(s.created_at) FILTER (WHERE s.status = 'paid') AS last_closed_at,
      -- Up to three resolved cities, so the state is recognisable without
      -- pretending to be a single location the data does not support.
      (SELECT string_agg(DISTINCT up.city, ', ')
         FROM (SELECT DISTINCT s2.r_city AS city FROM scoped s2
                WHERE s2.r_state = s.r_state AND s2.r_city IS NOT NULL
                ORDER BY 1 LIMIT 3) up) AS cities
    FROM scoped s
    WHERE s.r_state IS NOT NULL
    GROUP BY s.r_state
  )
  SELECT
    b.r_state,
    b.cities,
    b.technicians,
    b.closed_count,
    b.cancelled_count,
    b.scheduled_count,
    CASE
      WHEN (b.closed_count + b.cancelled_count) > 0
        THEN round(b.closed_count::numeric / (b.closed_count + b.cancelled_count) * 100, 1)
      ELSE NULL
    END AS closed_rate_pct,
    EXISTS (SELECT 1 FROM public.optimized_areas o
             WHERE o.state = b.r_state AND o.is_active) AS is_optimised,
    b.last_closed_at
  FROM by_state b
  ORDER BY b.closed_count DESC, b.r_state
  LIMIT greatest(coalesce(_limit, 25), 1);

END;
$fn$;

COMMENT ON FUNCTION public.area_leaderboard(int) IS
  'Areas ranked by the jobs that closed in them, with the same denominator the '
  'other reports use, so the next area to optimise can be chosen on evidence.';

REVOKE ALL ON FUNCTION public.area_leaderboard(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.area_leaderboard(int) FROM anon;
GRANT EXECUTE ON FUNCTION public.area_leaderboard(int) TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP FUNCTION IF EXISTS public.area_leaderboard(int);
--
--   parse_lead_location keeps its previous behaviour, which is the body in
--   20261030140000_optimized_areas_and_area_performance.sql minus the
--   invisible-character strip. Every report calls it, so restore it from that
--   file rather than dropping it.
--
-- No lead row is modified and no policy is altered.
-- =============================================================================