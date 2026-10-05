-- =============================================================================
-- Migration : 20261106000000_fix_lead_city_extraction.sql
-- Purpose   : Repair the city half of public.parse_lead_location().
--
-- WHY
--   parse_lead_location (20261030140000) shares one location definition across
--   the Optimisation, technician report and coverage features. Its p_city rule
--   required a comma before "STATE ZIP", and rejected a city candidate that
--   contained any digit. On real intake addresses like
--
--     "4556 Monarch Dr Sierra Vista, AZ 85635"   -- no comma before the street
--     "100 E Warm Springs Rd, Henderson NV 89615" -- state not followed by comma
--     "8230 4th St Los Angeles, CA 90048, USA"     -- candidate holds the house no.
--
--   it returned NULL for every case. Measured against this project's leads that
--   meant roughly two thirds of rows never resolved a city, so area rollups lost
--   those rows and the coverage fallback (20261105000000) matched a whole
--   state instead of one city.
--
--   The correct algorithm already ships client-side in src/lib/address-utils.ts
--   (extractCity / extractState) and is unit-tested in
--   src/lib/address-utils.test.ts; this migration ports it to SQL so the browser
--   and every database report can finally agree.
--
--   The state half had the same class of fault and is repaired here too, because
--   coverage cannot place a lead without it. Its code pattern had no word
--   boundary, so "815 Allerton St Redwood City, California 94063" matched "ia"
--   and that lead was attributed to Iowa. It now requires the code to stand
--   alone, and falls back to a full state name before the zip. p_zip is
--   unchanged: it is already anchored to the end of the address and behaves.
--
-- BLAST RADIUS
--   Area rollups (area_performance / area leaderboard) stop losing rows to a
--   NULL city, and stop reading "ia" out of "California". Rows that have a
--   city / state / zip column value are still preferred exactly as before; only
--   parsed addresses change.
--
-- ROLLBACK
--   Re-run 20261030140000_optimized_areas_and_area_performance.sql in the SQL
--   editor, or CREATE OR REPLACE this body back to the inline CASE that reads
--   from the address.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.us_state_code(_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  t text := lower(btrim(coalesce(_text, '')));
  codes text[] := ARRAY[
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC'];
  names text[] := ARRAY[
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
    'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
    'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
    'minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire',
    'new jersey','new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota',
    'tennessee','texas','utah','vermont','virginia','washington','west virginia',
    'wisconsin','wyoming','district of columbia'];
  i int;
  m record;
BEGIN
  IF t = '' THEN RETURN NULL; END IF;

  -- The whole input is exactly a two-letter code ("TX").
  IF upper(t) = ANY (codes) THEN
    RETURN upper(t);
  END IF;

  -- The whole input is exactly a full state name ("Texas").
  FOR i IN 1..array_length(names, 1) LOOP
    IF t = names[i] THEN RETURN codes[i]; END IF;
  END LOOP;

  -- A two-letter code appears as a word ("Dallas, TX", "TX 77002").
  FOR m IN
    SELECT tok[1] AS code
      FROM regexp_matches(_text, '\m([A-Za-z]{2})\M', 'gi') AS f(tok)
  LOOP
    IF upper(m.code) = ANY (codes) THEN
      RETURN upper(m.code);
    END IF;
  END LOOP;

  -- A full state name appears as a word ("Houston, Texas").
  FOR i IN 1..array_length(names, 1) LOOP
    IF t ~ ('\m' || names[i] || '\M') THEN RETURN codes[i]; END IF;
  END LOOP;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.us_state_code(text) IS
  'Resolve a state code from a free-text location. A standalone two-letter code wins, '
  'then a full state name anywhere in the text.';

CREATE OR REPLACE FUNCTION public.lead_address_city(_address text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_clean text;
  v_parts text[];
  v_last text;
  v_tail text;
  v_candidate text;
  v_city text;
  codes text[] := ARRAY[
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC'];
  names text[] := ARRAY[
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
    'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
    'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
    'minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire',
    'new jersey','new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota',
    'tennessee','texas','utah','vermont','virginia','washington','west virginia',
    'wisconsin','wyoming','district of columbia'];
  i int;
BEGIN
  IF _address IS NULL OR btrim(_address) = '' THEN RETURN NULL; END IF;

  v_clean := btrim(regexp_replace(
               regexp_replace(btrim(_address),
                 '\s*,?\s*(usa|u\.s\.a\.|u\.s\.|united states(\s+of\s+america)?)\s*[,.]?\s*$',
                 '', 'i'),
               '[\s,.]+$', ''));

  IF v_clean = '' THEN RETURN NULL; END IF;

  v_parts := ARRAY(
    SELECT p.part FROM string_to_array(v_clean, ',') AS p(part)
    WHERE btrim(p.part) <> '');

  IF cardinality(v_parts) = 0 THEN RETURN NULL; END IF;

  v_last := v_parts[cardinality(v_parts)];

  -- Strip a trailing zip from the last segment.
  v_tail := btrim(regexp_replace(v_last, '[0-9]{5}(-[0-9]{4})?\s*$', ''));

  -- If what remains is entirely a state, the city sits in the previous segment.
  IF v_tail = '' OR upper(v_tail) = ANY (codes) OR lower(v_tail) = ANY (names) THEN
    IF cardinality(v_parts) >= 2 THEN
      v_candidate := v_parts[cardinality(v_parts) - 1];
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    -- Strip a trailing state token from the last segment itself; that segment
    -- may carry both the street and the city ("... St, Henderson NV 89615").
    v_tail := btrim(regexp_replace(v_tail, '[\s,]+[A-Za-z]{2}\s*$', ''));
    FOR i IN 1..array_length(names, 1) LOOP
      v_tail := btrim(regexp_replace(v_tail, '[\s,]+' || names[i] || '\s*$', '', 'i'));
    END LOOP;
    v_candidate := v_tail;
  END IF;

  -- The candidate may still hold a street number and type before the city.
  v_city := regexp_replace(v_candidate,
    '(?i)^\d+[a-z]?\s+.*?\b(st|street|ave|avenue|av|dr|drive|ln|lane|ct|court|blvd|boulevard|bl|way|rd|road|pkwy|parkway|pky|ter|terrace|trl|trail|cir|circle|pl|place|sq|square|hwy|highway|expy|fwy|loop|path|row|pt|point|plz|plaza)\b\.?\s*',
    '', 'i');

  -- Unit designators the street strip can leave behind, e.g. "# B Houston".
  v_city := regexp_replace(v_city, '#[\w-]+\s*', '', 'g');
  v_city := btrim(regexp_replace(v_city, '[0-9]{5}(-[0-9]{4})?', ''));
  v_city := btrim(regexp_replace(v_city, '^[-,\s]+|[-,\s]+$', ''));

  -- A candidate that still opens with a house number is an address fragment,
  -- not a city. extractCity returns "Unknown" for these; returning NULL is the
  -- same answer in this schema, and matching it keeps the two implementations
  -- from disagreeing on a shape like "123 Main St".
  IF v_city = '' OR v_city ~ '^[0-9]' THEN RETURN NULL; END IF;

  RETURN initcap(lower(v_city));
END;
$fn$;

COMMENT ON FUNCTION public.lead_address_city(text) IS
  'City name from a free-form lead address. Ports src/lib/address-utils.ts so the '
  'database and the client resolve the same city.';

-- -----------------------------------------------------------------------------
-- Replace parse_lead_location with the same p_state / p_zip rules and a fixed p_city.
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
      -- State: a two-letter code standing on its own, else a full state name,
      -- either immediately before the zip. The leading \m matters: without it
      -- "California 94063" matched "ia" and Redwood City resolved to Iowa.
      -- Still restricted to real codes, because a bare two-letter run also
      -- matches ordinary words.
      COALESCE(
        CASE
          WHEN upper(nullif((regexp_match(c.a, '(?:\m|,)\s*([A-Za-z]{2})\s*[0-9]{5}(?:[- ][0-9]{4})?\s*$'))[1], ''))
               IN ('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                   'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                   'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                   'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                   'WI','WY','DC')
            THEN upper(nullif((regexp_match(c.a, '(?:\m|,)\s*([A-Za-z]{2})\s*[0-9]{5}(?:[- ][0-9]{4})?\s*$'))[1], ''))
        END,
        public.us_state_code(
          nullif((regexp_match(c.a, '[ ,]+([A-Za-z][A-Za-z]+(?: [A-Za-z]+)*)\s+[0-9]{5}(?:[- ][0-9]{4})?\s*$'))[1], '')
        )
      ) AS p_state,
      public.lead_address_city(c.a) AS p_city
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
