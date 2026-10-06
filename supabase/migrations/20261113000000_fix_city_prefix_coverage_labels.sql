-- Preserve "St." as a Saint abbreviation in a city name and remove a postal
-- street's terminal compass direction when it leaks into the parsed city.
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
      '\s*,?\s*(usa|u\.s\.a\.|u\.s\.|united states(\s+of\s+america)?)\s*[,.]?\s*$', '', 'i'),
    '[\s,.]+$', ''));
  IF v_clean = '' THEN RETURN NULL; END IF;

  v_parts := ARRAY(
    SELECT btrim(p.part)
      FROM unnest(string_to_array(v_clean, ',')) AS p(part)
     WHERE btrim(p.part) <> ''
  );
  IF cardinality(v_parts) = 0 THEN RETURN NULL; END IF;

  v_last := v_parts[cardinality(v_parts)];
  v_tail := btrim(regexp_replace(v_last, '[0-9]{5}(-[0-9]{4})?[\s,.]*$', ''));
  v_tail := btrim(regexp_replace(v_tail, '[,.]+$', ''));

  IF v_tail = '' OR upper(v_tail) = ANY(codes) OR lower(v_tail) = ANY(names) THEN
    IF cardinality(v_parts) >= 2 THEN
      v_candidate := v_parts[cardinality(v_parts) - 1];
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    IF v_tail ~ '[\s,.]+[A-Za-z]{2}[\s,.]*$'
       AND public.us_state_code((regexp_match(v_tail, '([A-Za-z]{2})[\s,.]*$'))[1]) IS NOT NULL THEN
      v_tail := btrim(regexp_replace(v_tail, '[\s,.]+[A-Za-z]{2}[\s,.]*$', ''));
    END IF;
    FOR i IN 1..array_length(names, 1) LOOP
      v_tail := btrim(regexp_replace(v_tail, '[\s,.]+' || names[i] || '[\s,.]*$', '', 'i'));
    END LOOP;
    v_candidate := v_tail;
  END IF;

  -- Expand Saint abbreviation before testing for a street suffix; otherwise
  -- "St. Charles" is mistakenly split at "St." and reduced to "Charles".
  v_candidate := regexp_replace(v_candidate, '\mSt\.[\s]+', 'Saint ', 'gi');
  v_city := regexp_replace(v_candidate,
    '^\d+[a-z]?\s+.*?\m(st|street|ave|avenue|av|dr|drive|ln|lane|ct|court|blvd|boulevard|bl|way|rd|road|pkwy|parkway|pky|ter|terrace|trl|trail|cir|circle|pl|place|sq|square|hwy|highway|expy|fwy|loop|path|row|pt|point|plz|plaza)\M\.?\s*',
    '', 'i');
  v_city := regexp_replace(v_city, '#[\w-]+\s*', '', 'g');
  v_city := btrim(regexp_replace(v_city, '[0-9]{5}(-[0-9]{4})?', ''));
  v_city := btrim(regexp_replace(v_city, '^[-,.\s]+|[-,.\s]+$', '', 'g'));
  v_city := regexp_replace(v_city, '\s+', ' ', 'g');
  v_city := btrim(regexp_replace(v_city, '^(N|S|E|W|NE|NW|SE|SW)[\s,.]+', '', 'i'));

  IF v_city = '' OR v_city ~ '^[0-9]' THEN RETURN NULL; END IF;
  RETURN initcap(lower(v_city));
END;
$fn$;

-- Treat Saint/St. spellings as aliases while preserving the state filter.
CREATE OR REPLACE FUNCTION public.us_place_coordinates(
  _city text,
  _state text DEFAULT NULL
)
RETURNS TABLE (latitude double precision, longitude double precision)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH candidate AS (
    SELECT regexp_replace(lower(btrim(coalesce(_city, ''))), '[^a-z0-9]', '', 'g') AS city_key,
           upper(nullif(btrim(coalesce(_state, '')), '')) AS state_key
  ),
  keys AS (
    SELECT city_key,
           CASE WHEN city_key LIKE 'saint%' THEN 'st' || substr(city_key, 6)
                WHEN city_key LIKE 'st%' THEN 'saint' || substr(city_key, 3)
                ELSE city_key END AS saint_alias,
           state_key
      FROM candidate
  ),
  matched AS MATERIALIZED (
    SELECT p.latitude,
           p.longitude,
           p.population,
           p.name,
           p.state_code,
           regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = k.city_key AS exact_name
      FROM public.us_places p
      CROSS JOIN keys k
     WHERE k.city_key <> ''
       AND (k.state_key IS NULL OR p.state_code = k.state_key)
       AND regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = ANY (ARRAY[
             k.city_key, k.city_key || 'cdp', k.city_key || 'city',
             k.city_key || 'town', k.city_key || 'village',
             k.city_key || 'borough', k.city_key || 'municipality',
             k.city_key || 'plantation', k.saint_alias,
             k.saint_alias || 'cdp', k.saint_alias || 'city',
             k.saint_alias || 'town', k.saint_alias || 'village',
             k.saint_alias || 'borough', k.saint_alias || 'municipality',
             k.saint_alias || 'plantation'
           ])
  ),
  state_count AS (
    SELECT count(DISTINCT state_code) AS states FROM matched
  )
  SELECT m.latitude, m.longitude
    FROM matched m
    CROSS JOIN keys k
    CROSS JOIN state_count s
   WHERE k.state_key IS NOT NULL OR s.states = 1
   ORDER BY m.exact_name DESC, m.population DESC NULLS LAST, m.name
   LIMIT 1;
$fn$;

-- Refresh names/coverage after the parser fix. Geocoded coordinates remain the
-- authoritative point for neighborhood addresses such as Westchester, CA.
DO $$
DECLARE
  v_spread record;
BEGIN
  SELECT * INTO v_spread FROM public.compute_all_lead_coverage();
  RAISE NOTICE 'Coverage labels refreshed: % checked, % good, % normal, % bad, % unlocated.',
    v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated;
END $$;
