-- A valid address is not always a Census place name (neighborhoods, directional
-- suffixes, alternate city names). When the Census address geocoder supplied a
-- valid point, use it even if the text parser could not name a Census place.

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

  IF _latitude BETWEEN -90 AND 90 AND _longitude BETWEEN -180 AND 180 THEN
    v_lat := _latitude;
    v_lng := _longitude;
  ELSIF v_city IS NOT NULL THEN
    SELECT p.latitude, p.longitude INTO v_lat, v_lng
      FROM public.us_place_coordinates(v_city, v_state) p;
  END IF;

  -- A parsed city/place or a valid geocoded point can locate the lead. If both
  -- are absent, do not label an unreadable address as zero coverage.
  IF (v_city IS NULL AND v_state IS NULL AND v_zip IS NULL)
     AND (v_lat IS NULL OR v_lng IS NULL) THEN
    RETURN;
  END IF;
  IF v_lat IS NULL OR v_lng IS NULL THEN
    RETURN;
  END IF;

  v_label := COALESCE(
    NULLIF(btrim(concat_ws(', ', v_city, v_state)), ''),
    NULLIF(btrim(concat_ws(' ', v_state, v_zip)), ''),
    v_zip, v_city, v_state,
    NULLIF(btrim(_address), ''),
    'Mapped address'
  );

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

CREATE OR REPLACE FUNCTION public.preview_lead_technician_coverage_at_point(
  _address text,
  _city text,
  _state text,
  _zip text,
  _latitude double precision,
  _longitude double precision
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
  IF _latitude IS NULL OR _longitude IS NULL
     OR _latitude NOT BETWEEN -90 AND 90
     OR _longitude NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'A valid map point is required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT * FROM public.calculate_lead_technician_coverage(
      _address, _city, _state, _zip, _latitude, _longitude
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.preview_lead_technician_coverage_at_point(
  text, text, text, text, double precision, double precision
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_lead_technician_coverage_at_point(
  text, text, text, text, double precision, double precision
) TO authenticated, service_role;
