-- Census place names can carry a legal/geographic suffix while customer and
-- technician addresses omit it (e.g. "Mariposa" vs "Mariposa CDP"). Resolve
-- those equivalent labels without fuzzy matching unrelated cities.

CREATE OR REPLACE FUNCTION public.us_place_coordinates(
  _city text,
  _state text DEFAULT NULL
)
RETURNS TABLE (latitude double precision, longitude double precision)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT p.latitude, p.longitude
    FROM public.us_places p
   WHERE NULLIF(btrim(coalesce(_city, '')), '') IS NOT NULL
     AND (NULLIF(btrim(coalesce(_state, '')), '') IS NULL
          OR p.state_code = upper(btrim(_state)))
     AND lower(p.name) = ANY (ARRAY[
           lower(btrim(_city)),
           lower(btrim(_city)) || ' cdp',
           lower(btrim(_city)) || ' city',
           lower(btrim(_city)) || ' town',
           lower(btrim(_city)) || ' village',
           lower(btrim(_city)) || ' borough',
           lower(btrim(_city)) || ' municipality',
           lower(btrim(_city)) || ' plantation'
         ])
   ORDER BY (lower(p.name) = lower(btrim(_city))) DESC,
            p.population DESC NULLS LAST,
            p.name
   LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION public.us_place_coordinates(text, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.us_place_coordinates(text, text) IS
  'Resolve a city against Census place names, including common Census suffixes '
  'such as CDP, city, town, village, borough, municipality and plantation. Exact '
  'name matches take priority. Internal lookup used by coverage functions.';

CREATE OR REPLACE FUNCTION public.technician_area_place(_area text)
RETURNS TABLE (
  city text,
  state_code text,
  latitude double precision,
  longitude double precision
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

  v_state := public.us_state_code(v_text);
  v_candidate := btrim(split_part(v_text, ',', 1));

  SELECT p.latitude, p.longitude
    INTO v_lat, v_lng
    FROM public.us_place_coordinates(v_candidate, v_state) p;

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
        FROM public.us_place_coordinates(v_stripped, v_state) p;

      IF v_lat IS NOT NULL THEN
        v_candidate := v_stripped;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT nullif(v_candidate, ''), v_state, v_lat, v_lng;
END;
$fn$;

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
  v_count        bigint := 0;
  v_active       bigint := 0;
  v_placeable    bigint := 0;
  v_radius_miles constant double precision := 40;
BEGIN
  SELECT * INTO c_lead FROM public.leads l WHERE l.id = _lead_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

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
    v_zip, v_city, v_state
  );

  IF c_lead.latitude BETWEEN -90 AND 90
     AND c_lead.longitude BETWEEN -180 AND 180 THEN
    v_lat := c_lead.latitude;
    v_lng := c_lead.longitude;
  END IF;

  IF (v_lat IS NULL OR v_lng IS NULL) AND v_city IS NOT NULL THEN
    SELECT p.latitude, p.longitude
      INTO v_lat, v_lng
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

-- Keep the set-based full recompute in agreement with the per-lead trigger.
CREATE OR REPLACE FUNCTION public.compute_all_lead_coverage()
RETURNS TABLE (checked bigint, good bigint, normal bigint, bad bigint, unlocated bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_active bigint;
  v_placeable bigint;
BEGIN
  SELECT count(*) FILTER (WHERE coalesce(t.is_active, true)),
         count(*) FILTER (
           WHERE coalesce(t.is_active, true)
             AND CASE WHEN t.latitude BETWEEN -90 AND 90
                           AND t.longitude BETWEEN -180 AND 180
                      THEN true
                      ELSE tp.latitude BETWEEN -90 AND 90
                           AND tp.longitude BETWEEN -180 AND 180
                 END
         )
    INTO v_active, v_placeable
    FROM public.technicians t
    LEFT JOIN LATERAL public.technician_area_place(t.area) tp ON true;

  IF v_placeable = 0 AND v_active > 0 THEN
    UPDATE public.leads l
       SET coverage_tech_count = NULL,
           coverage_level = NULL,
           coverage_area_label = NULL,
           coverage_checked_at = now()
     WHERE l.address IS NOT NULL OR l.city IS NOT NULL
        OR l.state IS NOT NULL OR l.zip_code IS NOT NULL;

    RETURN QUERY
      SELECT count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL),
             count(*) FILTER (WHERE l.coverage_level = 'good'),
             count(*) FILTER (WHERE l.coverage_level = 'normal'),
             count(*) FILTER (WHERE l.coverage_level = 'bad'),
             count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL
                               AND l.coverage_level IS NULL)
        FROM public.leads l;
    RETURN;
  END IF;

  WITH placed_tech AS MATERIALIZED (
    SELECT lower(btrim(t.name)) AS tech_name,
           CASE WHEN t.latitude BETWEEN -90 AND 90
                     AND t.longitude BETWEEN -180 AND 180
                THEN t.latitude ELSE tp.latitude END AS lat,
           CASE WHEN t.latitude BETWEEN -90 AND 90
                     AND t.longitude BETWEEN -180 AND 180
                THEN t.longitude ELSE tp.longitude END AS lng
      FROM public.technicians t
      LEFT JOIN LATERAL public.technician_area_place(t.area) tp ON true
     WHERE coalesce(t.is_active, true)
       AND CASE WHEN t.latitude BETWEEN -90 AND 90
                      AND t.longitude BETWEEN -180 AND 180
                THEN true
                ELSE tp.latitude BETWEEN -90 AND 90
                     AND tp.longitude BETWEEN -180 AND 180
           END
  ),
  placed_lead AS (
    SELECT l.id,
           CASE WHEN loc.city IS NULL AND loc.state IS NULL AND loc.zip_code IS NULL
                THEN NULL
                WHEN l.latitude BETWEEN -90 AND 90
                     AND l.longitude BETWEEN -180 AND 180
                THEN l.latitude ELSE up.latitude END AS lat,
           CASE WHEN loc.city IS NULL AND loc.state IS NULL AND loc.zip_code IS NULL
                THEN NULL
                WHEN l.latitude BETWEEN -90 AND 90
                     AND l.longitude BETWEEN -180 AND 180
                THEN l.longitude ELSE up.longitude END AS lng,
           loc.city,
           loc.state,
           loc.zip_code
      FROM public.leads l
      CROSS JOIN LATERAL public.parse_lead_location(
                         l.address, l.city, l.state, l.zip_code
                       ) AS loc
      LEFT JOIN LATERAL public.us_place_coordinates(loc.city, loc.state) up ON true
     WHERE l.address IS NOT NULL OR l.city IS NOT NULL
        OR l.state IS NOT NULL OR l.zip_code IS NOT NULL
  ),
  counts AS (
    SELECT pl.id,
           pl.city,
           pl.state,
           pl.zip_code,
           count(DISTINCT pt.tech_name) AS tech_count
      FROM placed_lead pl
      LEFT JOIN placed_tech pt
        ON pt.lat BETWEEN pl.lat - 0.8 AND pl.lat + 0.8
       AND (
            abs(pt.lng - pl.lng) <= LEAST(
              180.0,
              40.0 / (69.0 * GREATEST(abs(cos(radians(pl.lat))), 0.05)) + 0.05
            )
            OR 360.0 - abs(pt.lng - pl.lng) <= LEAST(
              180.0,
              40.0 / (69.0 * GREATEST(abs(cos(radians(pl.lat))), 0.05)) + 0.05
            )
       )
       AND public.haversine_miles(pl.lat, pl.lng, pt.lat, pt.lng) <= 40
     WHERE pl.lat IS NOT NULL AND pl.lng IS NOT NULL
     GROUP BY pl.id, pl.city, pl.state, pl.zip_code
  )
  UPDATE public.leads l
     SET coverage_tech_count = CASE
                                 WHEN c.id IS NULL THEN NULL
                                 ELSE c.tech_count::integer
                               END,
         coverage_level = CASE
                            WHEN c.id IS NULL THEN NULL
                            WHEN c.tech_count >= 10 THEN 'good'
                            WHEN c.tech_count >= 1 THEN 'normal'
                            ELSE 'bad'
                          END,
         coverage_area_label = CASE
                                 WHEN c.id IS NULL THEN NULL
                                 ELSE COALESCE(
                                   NULLIF(btrim(concat_ws(', ', c.city, c.state)), ''),
                                   NULLIF(btrim(concat_ws(' ', c.state, c.zip_code)), ''),
                                   c.zip_code, c.city, c.state
                                 )
                               END,
         coverage_checked_at = now()
    FROM placed_lead pl
    LEFT JOIN counts c ON c.id = pl.id
   WHERE l.id = pl.id;

  RETURN QUERY
    SELECT count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL),
           count(*) FILTER (WHERE l.coverage_level = 'good'),
           count(*) FILTER (WHERE l.coverage_level = 'normal'),
           count(*) FILTER (WHERE l.coverage_level = 'bad'),
           count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL
                             AND l.coverage_level IS NULL)
      FROM public.leads l;
END;
$fn$;

-- Refresh stored coverage now that previously unmatchable Census city aliases
-- resolve. This uses the set-based worker and only updates derived coverage data.
DO $$
DECLARE
  v_spread record;
BEGIN
  SELECT * INTO v_spread FROM public.compute_all_lead_coverage();
  RAISE NOTICE
    'Coverage refreshed: % checked, % good, % normal, % bad, % unlocated.',
    v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated;
END $$;
