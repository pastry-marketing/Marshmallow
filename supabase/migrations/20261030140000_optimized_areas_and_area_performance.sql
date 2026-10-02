-- =============================================================================
-- Migration : 20261030140000_optimized_areas_and_area_performance.sql
-- Purpose   : Let an Admin mark an area as worth optimising while approving a
--             payment, and show how that area has actually performed first.
--
-- THE PROBLEM THIS SOLVES
--   Optimisation is only useful if it is decided on evidence. Today the
--   Optimisation page reports paid work per technician and per area after the
--   fact, but there is nowhere to record "push more work into this area", and
--   nothing surfaces how a candidate area has performed at the moment the
--   decision is made.
--
--   Two things are badly needed at payment-approval time:
--     1. Where the job actually closed, in a form a human can confirm.
--     2. How many jobs have already closed in that area, so the tick is
--        informed rather than a guess.
--
-- WHY LOCATION PARSING IS EXTRACTED HERE
--   leads.city and leads.state are effectively empty on historical data -
--   2 of 371 paid leads carry them - while leads.address is populated on
--   371 of 371. So the only usable source for old rows is the address text.
--
--   That logic already exists inside tech_paid_performance. If a second copy
--   were written for the approval panel and for area_performance, the two
--   would inevitably drift, and the office would see "14 jobs already closed
--   here" on the approval screen disagree with the Optimisation page for the
--   same area. parse_lead_location() therefore becomes the single definition,
--   and tech_paid_performance is redefined to use it, so there is exactly one
--   implementation and one set of rules.
--
--   The precedence rules are unchanged from what is already applied, and are
--   deliberately conservative: an explicit city/state/zip column wins when it
--   holds something usable, otherwise zip and state are read from the end of
--   the address, and city is trusted only when the address is comma-delimited
--   and the parse is clean. Comma-less addresses cannot be parsed without
--   guessing, and guessing produces visibly wrong data, so those rows fall
--   through to state and zip. State is restricted to real two-letter codes
--   because the loose pattern produced values like "as" and "ce" from
--   addresses that merely ended in a number.
--
-- TABLES
--   public.optimized_areas - one row per area an Admin has marked. The mark
--   belongs to the area, not to a job, so a column on leads was rejected: it
--   would duplicate the same flag across every job in the area and make
--   unticking ambiguous.
--
--   THE GRAIN IS THE STATE, and that is a measured decision rather than a
--   preference. Paid work is concentrated at state level - CA 92, TX 68,
--   FL 48, GA 32, IL 21 - but almost not at all below it: the busiest single
--   zip carries 3 paid jobs. A zip-level tick would therefore show "3 jobs
--   already closed here", which is not evidence for anything. City is worse
--   still, because it is only reliably readable on 31% of addresses.
--
--   So the unique key is the state. City and zip are kept as descriptive
--   context for whichever city prompted the mark, and are not part of the key,
--   because marking Austin and Dallas as two separate optimisations of Texas
--   would split one decision into two.
--
-- PERMISSIONS
--   Admin only, matching the Optimization section and the Paid Approval
--   queue, which is already hard-locked to Admin. Every function is SECURITY
--   DEFINER because each aggregates leads the caller cannot read individually,
--   so each checks the caller's role itself and pins search_path.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Shared location resolution
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
    SELECT btrim(coalesce(_address, '')) AS a
  ),
  cleaned AS (
    -- drop a trailing country, then any trailing punctuation or whitespace.
    -- Several stored addresses end in a comma ("... Dallas, TX 75218,"),
    -- which would otherwise defeat the end-anchored zip and state patterns.
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
      -- A bare "two letters then a zip" also matches ordinary words, so the
      -- result is restricted to real state codes.
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

COMMENT ON FUNCTION public.parse_lead_location(text, text, text, text) IS
  'Resolves a lead location from the structured columns when usable, otherwise from the '
  'address text. Single definition shared by every performance report so the numbers '
  'cannot disagree between screens.';


-- -----------------------------------------------------------------------------
-- 2. Redefine tech_paid_performance to use the shared parser
--    Same output, same rules - the parsing block is replaced by a call.
-- -----------------------------------------------------------------------------
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
      lower(btrim(t.name))                     AS k,
      min(t.opr_code)                          AS opr_code,
      bool_or(coalesce(t.is_good_tech, false)) AS good_tech
    FROM public.technicians t
    WHERE coalesce(btrim(t.name), '') <> ''
    GROUP BY lower(btrim(t.name))
  ),
  scoped AS (
    SELECT
      lower(btrim(l.tech_name))  AS tech_key,
      btrim(l.tech_name)         AS tech_name,
      l.status,
      l.created_at,
      loc.city                   AS r_city,
      loc.state                  AS r_state,
      loc.zip_code               AS r_zip,
      nullif(btrim(l.address), '') AS x_addr
    FROM public.leads l
    CROSS JOIN LATERAL public.parse_lead_location(
      l.address, l.city, l.state, l.zip_code
    ) AS loc
    WHERE l.status IN ('paid', 'cancelled', 'scheduled')
      AND coalesce(btrim(l.tech_name), '') <> ''
      AND (_from IS NULL OR l.created_at >= _from)
      AND (_to   IS NULL OR l.created_at <  _to)
  ),
  agg AS (
    SELECT
      s.tech_key,
      max(s.tech_name)                                  AS tech_name,
      count(*) FILTER (WHERE s.status = 'paid')          AS paid_count,
      count(*) FILTER (WHERE s.status = 'cancelled')     AS cancelled_count,
      count(*) FILTER (WHERE s.status = 'scheduled')     AS scheduled_count,
      max(s.created_at) FILTER (WHERE s.status = 'paid') AS last_paid_at
    FROM scoped s
    GROUP BY s.tech_key
  ),
  loc AS (
    -- Most recent resolvable location per technician.
    SELECT DISTINCT ON (s.tech_key)
      s.tech_key,
      s.r_city,
      s.r_state,
      s.r_zip,
      coalesce(
        CASE WHEN s.r_city IS NOT NULL AND s.r_state IS NOT NULL
             THEN trim(concat_ws(', ', s.r_city, s.r_state)) END,
        CASE WHEN s.r_state IS NOT NULL AND s.r_zip IS NOT NULL
             THEN trim(concat_ws(' ', s.r_state, s.r_zip)) END,
        s.r_city,
        s.r_state,
        s.r_zip,
        nullif(left(btrim(s.x_addr), 60), '')
      ) AS location_label
    FROM scoped s
    WHERE s.r_city IS NOT NULL
       OR s.r_state IS NOT NULL
       OR s.r_zip IS NOT NULL
       OR s.x_addr IS NOT NULL
    ORDER BY s.tech_key, s.created_at DESC NULLS LAST
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

REVOKE ALL ON FUNCTION public.tech_paid_performance(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tech_paid_performance(timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.tech_paid_performance(timestamptz, timestamptz) TO authenticated;


-- -----------------------------------------------------------------------------
-- 3. Areas an Admin has marked for optimisation
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.optimized_areas (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city      text,
  state     text,
  zip_code  text,
  -- Kept alongside the parts so the list renders identically to the parsed
  -- labels elsewhere, without each caller rebuilding the string.
  label     text NOT NULL,
  note      text,
  is_active boolean NOT NULL DEFAULT true,
  marked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT optimized_areas_area_key UNIQUE (state)
);

COMMENT ON TABLE public.optimized_areas IS
  'Areas an Admin has marked as worth optimising from the payment approval screen. '
  'One row per area; the mark belongs to the area rather than to a single job.';

CREATE INDEX IF NOT EXISTS optimized_areas_active_idx
  ON public.optimized_areas (is_active, marked_at DESC);

ALTER TABLE public.optimized_areas ENABLE ROW LEVEL SECURITY;

-- Admin only, matching the Optimization section and the Paid Approval queue.
DROP POLICY IF EXISTS "Admins can view optimized areas" ON public.optimized_areas;
CREATE POLICY "Admins can view optimized areas"
  ON public.optimized_areas FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can insert optimized areas" ON public.optimized_areas;
CREATE POLICY "Admins can insert optimized areas"
  ON public.optimized_areas FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can update optimized areas" ON public.optimized_areas;
CREATE POLICY "Admins can update optimized areas"
  ON public.optimized_areas FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can delete optimized areas" ON public.optimized_areas;
CREATE POLICY "Admins can delete optimized areas"
  ON public.optimized_areas FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

REVOKE ALL ON TABLE public.optimized_areas FROM anon;


-- -----------------------------------------------------------------------------
-- 4. Evidence for the approval screen: how an area has actually performed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.area_performance(
  _city text DEFAULT NULL,
  _state text DEFAULT NULL,
  _zip  text DEFAULT NULL
)
RETURNS TABLE (
  area_label      text,
  technicians     bigint,
  paid_count      bigint,
  cancelled_count bigint,
  scheduled_count bigint,
  closed_rate_pct numeric,
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
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only admins may read area performance'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT
      l.status,
      l.created_at,
      lower(btrim(l.tech_name)) AS tech_key,
      loc.city                   AS r_city,
      loc.state                  AS r_state,
      loc.zip_code               AS r_zip
    FROM public.leads l
    CROSS JOIN LATERAL public.parse_lead_location(
      l.address, l.city, l.state, l.zip_code
    ) AS loc
    WHERE l.status IN ('paid', 'cancelled', 'scheduled')
      AND coalesce(btrim(l.tech_name), '') <> ''
      -- Match at state level, which is the grain the evidence is meaningful at:
      -- CA has 92 closed jobs, the busiest zip has 3.
      AND (loc.state = upper(_state))
  )
  SELECT
    coalesce(
      nullif(trim(concat_ws(', ', _city, _state)), ''),
      coalesce(_state, _zip, _city, '')
    ) AS area_label,
    count(DISTINCT tech_key) AS technicians,
    count(*) FILTER (WHERE status = 'paid')      AS paid_count,
    count(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
    count(*) FILTER (WHERE status = 'scheduled') AS scheduled_count,
    CASE
      WHEN (count(*) FILTER (WHERE status = 'paid')
          + count(*) FILTER (WHERE status = 'cancelled')) > 0
        THEN round(
          count(*) FILTER (WHERE status = 'paid')::numeric
          / (count(*) FILTER (WHERE status = 'paid')
             + count(*) FILTER (WHERE status = 'cancelled')) * 100, 1)
      ELSE NULL
    END AS closed_rate_pct,
    max(created_at) FILTER (WHERE status = 'paid') AS last_paid_at
  FROM scoped;

END;
$fn$;

COMMENT ON FUNCTION public.area_performance(text, text, text) IS
  'How many jobs have already closed in a candidate area, so the Optimise this area tick '
  'is decided on evidence. Uses the same location parser as the technician report.';

REVOKE ALL ON FUNCTION public.area_performance(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.area_performance(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.area_performance(text, text, text) TO authenticated;


-- -----------------------------------------------------------------------------
-- 5. Live counts for every marked area, for the Optimization page
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.optimized_areas_with_performance()
RETURNS TABLE (
  id              uuid,
  city            text,
  state           text,
  zip_code        text,
  label           text,
  note            text,
  is_active       boolean,
  marked_at       timestamptz,
  technicians     bigint,
  paid_count      bigint,
  cancelled_count bigint,
  scheduled_count bigint,
  closed_rate_pct numeric
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
    RAISE EXCEPTION 'Only admins may read optimized areas'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT
      l.status,
      lower(btrim(l.tech_name)) AS tech_key,
      loc.city                   AS r_city,
      loc.state                  AS r_state,
      loc.zip_code               AS r_zip
    FROM public.leads l
    CROSS JOIN LATERAL public.parse_lead_location(
      l.address, l.city, l.state, l.zip_code
    ) AS loc
    WHERE l.status IN ('paid', 'cancelled', 'scheduled')
      AND coalesce(btrim(l.tech_name), '') <> ''
  )
  SELECT
    a.id, a.city, a.state, a.zip_code, a.label, a.note, a.is_active, a.marked_at,
    count(DISTINCT s.tech_key) AS technicians,
    count(*) FILTER (WHERE s.status = 'paid')      AS paid_count,
    count(*) FILTER (WHERE s.status = 'cancelled') AS cancelled_count,
    count(*) FILTER (WHERE s.status = 'scheduled') AS scheduled_count,
    CASE
      WHEN (count(*) FILTER (WHERE s.status = 'paid')
          + count(*) FILTER (WHERE s.status = 'cancelled')) > 0
        THEN round(
          count(*) FILTER (WHERE s.status = 'paid')::numeric
          / (count(*) FILTER (WHERE s.status = 'paid')
             + count(*) FILTER (WHERE s.status = 'cancelled')) * 100, 1)
      ELSE NULL
    END AS closed_rate_pct
  FROM public.optimized_areas a
  LEFT JOIN scoped s
    ON a.state IS NOT NULL AND s.r_state = a.state
  GROUP BY a.id, a.city, a.state, a.zip_code, a.label, a.note, a.is_active, a.marked_at
  ORDER BY a.is_active DESC, a.marked_at DESC;

END;
$fn$;

COMMENT ON FUNCTION public.optimized_areas_with_performance() IS
  'Marked optimization areas with their live closed, cancelled and scheduled counts.';

REVOKE ALL ON FUNCTION public.optimized_areas_with_performance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.optimized_areas_with_performance() FROM anon;
GRANT EXECUTE ON FUNCTION public.optimized_areas_with_performance() TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP FUNCTION IF EXISTS public.optimized_areas_with_performance();
--   DROP FUNCTION IF EXISTS public.area_performance(text, text, text);
--   DROP TABLE IF EXISTS public.optimized_areas;
--   DROP FUNCTION IF EXISTS public.parse_lead_location(text, text, text, text);
--
-- tech_paid_performance is left in place because this migration only redefines
-- it to call the shared parser; rolling back the parser alone would break it.
-- If you also need to revert that change, restore the previous function body
-- from migration 20261030120000_tech_paid_performance.sql.
--
-- No lead row is modified by this migration, and no existing policy is altered,
-- so the rollback is otherwise complete.
-- =============================================================================
