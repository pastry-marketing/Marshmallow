-- Make Census city matching tolerant of punctuation/spacing and expose a safe,
-- authenticated preview so users can see the derived coverage before saving.

-- Normalize trailing punctuation and repeated whitespace while extracting a
-- city from free-form intake text such as "City. State. ZIP" or extra commas.
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

  v_city := regexp_replace(v_candidate,
    '^\d+[a-z]?\s+.*?\m(st|street|ave|avenue|av|dr|drive|ln|lane|ct|court|blvd|boulevard|bl|way|rd|road|pkwy|parkway|pky|ter|terrace|trl|trail|cir|circle|pl|place|sq|square|hwy|highway|expy|fwy|loop|path|row|pt|point|plz|plaza)\M\.?\s*',
    '', 'i');
  v_city := regexp_replace(v_city, '#[\w-]+\s*', '', 'g');
  v_city := btrim(regexp_replace(v_city, '[0-9]{5}(-[0-9]{4})?', ''));
  v_city := btrim(regexp_replace(v_city, '^[-,.\s]+|[-,.\s]+$', '', 'g'));
  v_city := regexp_replace(v_city, '\s+', ' ', 'g');

  IF v_city = '' OR v_city ~ '^[0-9]' THEN RETURN NULL; END IF;
  RETURN initcap(lower(v_city));
END;
$fn$;

-- Allow punctuation after state codes/full state names before the ZIP, while
-- retaining the existing preference for valid explicit structured columns.
CREATE OR REPLACE FUNCTION public.parse_lead_location(
  _address text,
  _city text,
  _state text,
  _zip text
)
RETURNS TABLE (city text, state text, zip_code text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  WITH stripped AS (
    SELECT btrim(coalesce(_address, '')) AS address
  ),
  cleaned AS (
    SELECT btrim(regexp_replace(
      regexp_replace(address, '\s*,?\s*(USA|U\.S\.A\.|United States|US)\s*[,.]?\s*$', '', 'i'),
      '[\s,.]+$', ''
    )) AS address
    FROM stripped
  ),
  parsed AS (
    SELECT c.address,
      nullif((regexp_match(c.address, '([0-9]{5})(?:[- ][0-9]{4})?\s*[,.]*$'))[1], '') AS parsed_zip,
      COALESCE(
        CASE
          WHEN upper(nullif((regexp_match(c.address, '(?:\m|,)\s*([A-Za-z]{2})[\s,.]*[0-9]{5}(?:[- ][0-9]{4})?\s*[,.]*$'))[1], ''))
               IN ('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                   'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                   'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                   'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                   'WI','WY','DC')
          THEN upper(nullif((regexp_match(c.address, '(?:\m|,)\s*([A-Za-z]{2})[\s,.]*[0-9]{5}(?:[- ][0-9]{4})?\s*[,.]*$'))[1], ''))
        END,
        public.us_state_code(nullif((regexp_match(
          c.address,
          '[ ,]+([A-Za-z][A-Za-z .]*?)[\s,.]+[0-9]{5}(?:[- ][0-9]{4})?\s*[,.]*$'
        ))[1], ''))
      ) AS parsed_state,
      public.lead_address_city(c.address) AS parsed_city
    FROM cleaned c
  )
  SELECT
    COALESCE(
      NULLIF(btrim(regexp_replace(coalesce(_city, ''), '[,.]+$', '')), ''),
      p.parsed_city
    ),
    COALESCE(public.us_state_code(_state), p.parsed_state),
    CASE WHEN btrim(coalesce(_zip, '')) ~ '^[0-9]{5}(-[0-9]{4})?$'
         THEN btrim(_zip) ELSE p.parsed_zip END
  FROM parsed p;
$fn$;

CREATE INDEX IF NOT EXISTS us_places_normalized_name_state_idx
  ON public.us_places (
    state_code,
    (regexp_replace(lower(name), '[^a-z0-9]', '', 'g'))
  );

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
  matched AS MATERIALIZED (
    SELECT p.latitude,
           p.longitude,
           p.population,
           p.name,
           p.state_code,
           regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = c.city_key AS exact_name
      FROM public.us_places p
      CROSS JOIN candidate c
     WHERE c.city_key <> ''
       AND (c.state_key IS NULL OR p.state_code = c.state_key)
       AND regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = ANY (ARRAY[
             c.city_key,
             c.city_key || 'cdp',
             c.city_key || 'city',
             c.city_key || 'town',
             c.city_key || 'village',
             c.city_key || 'borough',
             c.city_key || 'municipality',
             c.city_key || 'plantation'
           ])
  ),
  state_count AS (
    SELECT count(DISTINCT state_code) AS states
      FROM matched
  )
  SELECT m.latitude, m.longitude
    FROM matched m
    CROSS JOIN candidate c
    CROSS JOIN state_count s
   WHERE c.state_key IS NOT NULL OR s.states = 1
   ORDER BY m.exact_name DESC, m.population DESC NULLS LAST, m.name
   LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.calculate_lead_technician_coverage(
  _address text,
  _city text,
  _state text,
  _zip text,
  _latitude double precision,
  _longitude double precision
)
RETURNS TABLE (tech_count bigint, area_label text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_lat          double precision;
  v_lng          double precision;
  v_city         text;
  v_state        text;
  v_zip          text;
  v_label        text;
  v_count        bigint := 0;
  v_active       bigint := 0;
  v_placeable    bigint := 0;
  v_radius_miles constant double precision := 40;
BEGIN
  SELECT loc.city, loc.state, loc.zip_code
    INTO v_city, v_state, v_zip
    FROM public.parse_lead_location(_address, _city, _state, _zip) AS loc;

  IF v_city IS NULL AND v_state IS NULL AND v_zip IS NULL THEN
    RETURN;
  END IF;

  v_label := COALESCE(
    NULLIF(btrim(concat_ws(', ', v_city, v_state)), ''),
    NULLIF(btrim(concat_ws(' ', v_state, v_zip)), ''),
    v_zip, v_city, v_state
  );

  IF _latitude BETWEEN -90 AND 90 AND _longitude BETWEEN -180 AND 180 THEN
    v_lat := _latitude;
    v_lng := _longitude;
  END IF;

  IF (v_lat IS NULL OR v_lng IS NULL) AND v_city IS NOT NULL THEN
    SELECT p.latitude, p.longitude INTO v_lat, v_lng
      FROM public.us_place_coordinates(v_city, v_state) p;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    RETURN;
  END IF;

  WITH active_tech AS MATERIALIZED (
    SELECT lower(btrim(t.name)) AS tech_name,
           t.area,
           CASE WHEN t.latitude BETWEEN -90 AND 90
                     AND t.longitude BETWEEN -180 AND 180
                THEN t.latitude END AS stored_lat,
           CASE WHEN t.latitude BETWEEN -90 AND 90
                     AND t.longitude BETWEEN -180 AND 180
                THEN t.longitude END AS stored_lng
      FROM public.technicians t
     WHERE coalesce(t.is_active, true)
  ),
  areas_to_place AS MATERIALIZED (
    SELECT DISTINCT t.area
      FROM active_tech t
     WHERE t.stored_lat IS NULL
       AND NULLIF(btrim(coalesce(t.area, '')), '') IS NOT NULL
  ),
  placed_areas AS MATERIALIZED (
    SELECT a.area, p.latitude, p.longitude
      FROM areas_to_place a
      LEFT JOIN LATERAL public.technician_area_place(a.area) p ON true
  ),
  placed_tech AS MATERIALIZED (
    SELECT t.tech_name,
           coalesce(t.stored_lat, p.latitude) AS lat,
           coalesce(t.stored_lng, p.longitude) AS lng
      FROM active_tech t
      LEFT JOIN placed_areas p ON p.area = t.area
  )
  SELECT count(*),
         count(*) FILTER (WHERE pt.lat BETWEEN -90 AND 90
                            AND pt.lng BETWEEN -180 AND 180),
         count(DISTINCT pt.tech_name) FILTER (
           WHERE pt.lat BETWEEN v_lat - 0.8 AND v_lat + 0.8
             AND (
               abs(pt.lng - v_lng) <= LEAST(
                 180.0,
                 v_radius_miles / (69.0 * GREATEST(abs(cos(radians(v_lat))), 0.05)) + 0.05
               )
               OR 360.0 - abs(pt.lng - v_lng) <= LEAST(
                 180.0,
                 v_radius_miles / (69.0 * GREATEST(abs(cos(radians(v_lat))), 0.05)) + 0.05
               )
             )
             AND public.haversine_miles(v_lat, v_lng, pt.lat, pt.lng) <= v_radius_miles
         )
    INTO v_active, v_placeable, v_count
    FROM placed_tech pt;

  IF v_active > 0 AND v_placeable = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT coalesce(v_count, 0), v_label;
END;
$fn$;

REVOKE ALL ON FUNCTION public.calculate_lead_technician_coverage(
  text, text, text, text, double precision, double precision
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lead_technician_coverage(_lead_id uuid)
RETURNS TABLE (tech_count bigint, area_label text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_lead public.leads%ROWTYPE;
BEGIN
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = _lead_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT * FROM public.calculate_lead_technician_coverage(
      v_lead.address, v_lead.city, v_lead.state, v_lead.zip_code,
      v_lead.latitude, v_lead.longitude
    );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.preview_lead_technician_coverage(
  _address text,
  _city text DEFAULT NULL,
  _state text DEFAULT NULL,
  _zip text DEFAULT NULL
)
RETURNS TABLE (tech_count bigint, area_label text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to preview lead coverage' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT * FROM public.calculate_lead_technician_coverage(
      _address, _city, _state, _zip, NULL, NULL
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.preview_lead_technician_coverage(text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_lead_technician_coverage(text, text, text, text)
  TO authenticated, service_role;

-- Recompute existing rows using normalized city matching. This also aligns any
-- previously unlocated address whose only mismatch was punctuation or spacing.
DO $$
DECLARE
  v_spread record;
BEGIN
  SELECT * INTO v_spread FROM public.compute_all_lead_coverage();
  RAISE NOTICE 'Coverage normalized: % checked, % good, % normal, % bad, % unlocated.',
    v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated;
END $$;
