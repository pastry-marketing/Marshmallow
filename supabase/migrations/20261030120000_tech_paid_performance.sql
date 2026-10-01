-- =============================================================================
-- Migration : 20261030120000_tech_paid_performance.sql
-- Purpose   : Back the new admin-only Optimization section with a single
--             aggregated, permission-checked read instead of downloading leads
--             and technicians to the browser and joining them there.
--
-- WHY THIS EXISTS
--   The Optimization section answers one question: which technicians and which
--   locations actually convert to paid work, so staffing can be optimised. That
--   needs an aggregate over leads grouped by technician, plus the technician's
--   own attributes. Neither table can be joined safely in the browser:
--
--     * public.leads has no technician_id. A lead records its technician only as
--       free text in leads.tech_name, and public.technicians holds 2,671 rows
--       across just 1,177 distinct names - 332 names are duplicated. A name
--       join fans out: joining the 369 paid leads produced 4,191 rows, which
--       would inflate every count on the page.
--
--     * Only 369 of 3,914 leads carry a technician name, and those are almost
--       entirely the leads where a technician was actually engaged: paid 369/371,
--       scheduled 333/335, job_in_progress 32/32, but only 56/1,288 of
--       waiting_customer_response. So the denominator for a paid rate has to be
--       the tech-engaged set, not all leads.
--
--     * Doing this client-side would mean shipping every lead to the browser,
--       which is the exact pattern the lead list work just removed.
--
-- LOCATION RESOLUTION
--   The request was: if city or state is missing, fall back to address or zip.
--   On paid leads the structured columns are almost entirely empty - city 2,
--   state 2, zip_code 0 - but leads.address is populated on 371 of 371, so the
--   address is the only usable source and it has to be parsed.
--
--   The stored addresses are inconsistent, so the parser is layered and each
--   step is validated against all 371 live paid leads:
--
--     6960 Casselberry WaySan Diego, CA 92119, USA   (no space, trailing USA)
--     8200 Dixon Ave Silver Spring, MD 20910          (no comma before city)
--     3752 Sunflower St, Lexington, KY 40509         (well formed)
--
--   Order of preference per lead: the explicit city/state/zip columns, then a
--   parse of the address from the end (zip, then the state code that precedes
--   it, then the city before that), then the raw address. Measured coverage on
--   paid leads: city 95.4%, zip 93.8%, state 92.2%, and every paid lead
--   resolves to at least the raw address, so the page never shows a blank.
--
--   The location shown for a technician is taken from their most recent
--   tech-engaged lead that resolves to anything.
--
-- GOOD TECH
--   technicians.is_good_tech already exists and is managed by hand in the
--   Technicians page. This migration only reads it. Because names are
--   duplicated, a technician counts as Good Tech if any row sharing that name is
--   flagged, and the OPR code is the lowest non-null one so the join stays
--   one row per technician.
--
-- PERMISSIONS
--   Admin only, matching the sidebar section. The function is SECURITY DEFINER
--   because it aggregates leads the caller cannot read individually, so it
--   checks the caller's role itself and pins search_path. Grants are limited to
--   authenticated; anon gets nothing.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================

-- Supports the GROUP BY in the function below: one row per technician per
-- status, covering only the leads that actually name a technician. Without it
-- the aggregate needs a sort over the whole table.
CREATE INDEX IF NOT EXISTS leads_tech_performance_idx
  ON public.leads (lower(btrim(tech_name)), status)
  WHERE coalesce(btrim(tech_name), '') <> '';


CREATE OR REPLACE FUNCTION public.tech_paid_performance(
  _from timestamptz DEFAULT NULL,
  _to   timestamptz DEFAULT NULL
)
RETURNS TABLE (
  tech_name       text,
  paid_count      bigint,
  cancelled_count bigint,
  scheduled_count bigint,
  paid_rate_pct   numeric,
  city            text,
  state           text,
  zip_code        text,
  location_label  text,
  opr_code        text,
  good_tech       boolean,
  last_paid_at    timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Admin only. A SECURITY DEFINER function bypasses RLS, so the role check
  -- cannot be left to the policies on leads.
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only admins may read technician performance'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH tech_attr AS (
    -- One row per distinct technician name. min()/bool_or() rather than a plain
    -- join, because 332 names are duplicated and a direct join would multiply
    -- the lead counts.
    SELECT
      lower(btrim(t.name))                       AS k,
      min(t.opr_code)                            AS opr_code,
      bool_or(coalesce(t.is_good_tech, false))   AS good_tech
    FROM public.technicians t
    WHERE coalesce(btrim(t.name), '') <> ''
    GROUP BY lower(btrim(t.name))
  ),
  scoped AS (
    SELECT
      lower(btrim(l.tech_name))            AS tech_key,
      btrim(l.tech_name)                   AS tech_name,
      l.status,
      l.created_at,
      nullif(btrim(l.city), '')            AS x_city,
      nullif(btrim(l.state), '')           AS x_state,
      nullif(btrim(l.zip_code), '')        AS x_zip,
      nullif(btrim(l.address), '')         AS x_addr
    FROM public.leads l
    WHERE l.status IN ('paid', 'cancelled', 'scheduled')
      AND coalesce(btrim(l.tech_name), '') <> ''
      AND (_from IS NULL OR l.created_at >= _from)
      AND (_to   IS NULL OR l.created_at <  _to)
  ),
  stripped AS (
    SELECT s.*,
      -- Drop a trailing country, then any trailing punctuation or whitespace.
      -- Several stored addresses end in a comma ("... Dallas, TX 75218,"), which
      -- would otherwise defeat the end-anchored zip and state patterns below.
      btrim(regexp_replace(
        regexp_replace(
          coalesce(s.x_addr, ''),
          '\s*,?\s*(USA|U\.S\.A\.|United States|US)\s*[,.]?\s*$',
          '',
          'i'
        ),
        '[\s,.]+$',
        ''
      )) AS a_clean
    FROM scoped s
  ),
  parsed AS (
    -- Zip and state are read from the END of the string with unambiguous
    -- patterns, so they are trustworthy.
    --
    -- City is different. Only the comma-delimited form is trusted, and only
    -- when the result contains no digits and does not end in a street suffix.
    -- The comma-less addresses cannot be parsed reliably without guessing, and
    -- guessing is worse than falling back: substring matching corrupts real city
    -- names, because "Houston" contains "st" and "Winchester" contains "ter".
    -- Those rows fall through to state and zip, which is where the page shows
    -- them instead.
    SELECT s.*,
      nullif(
        (regexp_match(s.a_clean, '([0-9]{5})(?:[- ][0-9]{4})?\s*$'))[1], ''
      ) AS p_zip,
      -- A bare "two letters then a zip" pattern also matches ordinary words, and
      -- the live data proves it: it produced 'as', 'ce' and 'ke' from addresses
      -- that merely end in a number. Restricting to the real codes keeps the
      -- column trustworthy; anything else falls through to zip.
      CASE
        WHEN upper(nullif(
               (regexp_match(s.a_clean, '([A-Za-z]{2})\s+[0-9]{5}(?:[- ][0-9]{4})?\s*$'))[1],
               ''
             )) IN ('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                    'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                    'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                    'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                    'WI','WY','DC')
          THEN upper(nullif(
                 (regexp_match(s.a_clean, '([A-Za-z]{2})\s+[0-9]{5}(?:[- ][0-9]{4})?\s*$'))[1],
                 ''
               ))
      END AS p_state,
      CASE
        WHEN nullif(btrim((regexp_match(s.a_clean, '([^,]+),\s*([A-Za-z]{2})\s+[0-9]{5}'))[1]), '')
             ~ '[0-9#]' IS TRUE
          THEN NULL
        WHEN lower(nullif(btrim((regexp_match(s.a_clean, '([^,]+),\s*([A-Za-z]{2})\s+[0-9]{5}'))[1]), ''))
             ~ '(^|\s)(st|street|ave|avenue|av|dr|drive|ln|lane|ct|court|blvd|boulevard|bl|way|rd|road|pkwy|parkway|pky|ter|terrace|trl|trail|cir|circle|pl|place|sq|square|hwy|highway|expy|fwy|loop|path|row|pt|point|plz|plaza)\.?$'
          THEN NULL
        ELSE nullif(btrim((regexp_match(s.a_clean, '([^,]+),\s*([A-Za-z]{2})\s+[0-9]{5}'))[1]), '')
      END AS p_city
    FROM stripped s
  ),
  resolved AS (
    -- The explicit columns win when they hold something usable. state is
    -- accepted only as a clean two-letter code, because the live data has one
    -- row where the field was filled in as "MI 49022".
    SELECT
      p.*,
      CASE WHEN p.x_city IS NOT NULL THEN p.x_city ELSE p.p_city END AS r_city,
      CASE
        WHEN upper(coalesce(p.x_state, '')) ~ '^[A-Z]{2}$' THEN upper(p.x_state)
        ELSE p.p_state
      END AS r_state,
      CASE
        WHEN p.x_zip ~ '^[0-9]{5}(-[0-9]{4})?$' THEN p.x_zip
        ELSE p.p_zip
      END AS r_zip
    FROM parsed p
  ),
  agg AS (
    SELECT
      r.tech_key,
      max(r.tech_name)                                          AS tech_name,
      count(*) FILTER (WHERE r.status = 'paid')                  AS paid_count,
      count(*) FILTER (WHERE r.status = 'cancelled')             AS cancelled_count,
      count(*) FILTER (WHERE r.status = 'scheduled')             AS scheduled_count,
      max(r.created_at) FILTER (WHERE r.status = 'paid')         AS last_paid_at
    FROM resolved r
    GROUP BY r.tech_key
  ),
  loc AS (
    -- Most recent resolvable location per technician.
    SELECT DISTINCT ON (r.tech_key)
      r.tech_key,
      r.r_city,
      r.r_state,
      r.r_zip,
      coalesce(
        -- "City, ST" when the city parse is trustworthy
        CASE WHEN r.r_city IS NOT NULL AND r.r_state IS NOT NULL
             THEN trim(concat_ws(', ', r.r_city, r.r_state)) END,
        -- otherwise the reliable fields, which is the requested fallback
        CASE WHEN r.r_state IS NOT NULL AND r.r_zip IS NOT NULL
             THEN trim(concat_ws(' ', r.r_state, r.r_zip)) END,
        r.r_city,
        r.r_state,
        r.r_zip,
        -- last resort: the address itself, so a row is never blank
        nullif(left(btrim(r.x_addr), 60), '')
      ) AS location_label
    FROM resolved r
    WHERE r.r_city IS NOT NULL
       OR r.r_state IS NOT NULL
       OR r.r_zip IS NOT NULL
       OR r.x_addr IS NOT NULL
    ORDER BY r.tech_key, r.created_at DESC NULLS LAST
  )
  SELECT
    a.tech_name,
    a.paid_count,
    a.cancelled_count,
    a.scheduled_count,
    CASE
      WHEN (a.paid_count + a.cancelled_count) > 0
        THEN round(a.paid_count::numeric / (a.paid_count + a.cancelled_count) * 100, 1)
      ELSE NULL
    END AS paid_rate_pct,
    l.r_city      AS city,
    l.r_state     AS state,
    l.r_zip       AS zip_code,
    l.location_label,
    t.opr_code,
    coalesce(t.good_tech, false) AS good_tech,
    a.last_paid_at
  FROM agg a
  LEFT JOIN loc l ON l.tech_key = a.tech_key
  LEFT JOIN tech_attr t ON t.k = a.tech_key
  ORDER BY a.paid_count DESC, a.tech_name;

END;
$fn$;

COMMENT ON FUNCTION public.tech_paid_performance(timestamptz, timestamptz) IS
  'Admin-only per-technician paid / cancelled / scheduled counts with a paid '
  'rate, for the Optimization section. Location is resolved from the lead''s '
  'city/state/zip columns first, then parsed from the address text.';

-- SECURITY DEFINER plus a narrow grant: the function does its own role check,
-- and anon has no business reaching it either way.
REVOKE ALL ON FUNCTION public.tech_paid_performance(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tech_paid_performance(timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.tech_paid_performance(timestamptz, timestamptz) TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP INDEX IF EXISTS public.leads_tech_performance_idx;
--   DROP FUNCTION IF EXISTS public.tech_paid_performance(timestamptz, timestamptz);
--
-- Nothing else in this migration writes to any table, and no existing policy,
-- function or column is altered, so this rollback is complete and safe.
-- The frontend must be rolled back at the same time, since the Optimization
-- page calls this function.
-- =============================================================================
