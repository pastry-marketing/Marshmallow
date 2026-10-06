-- A full coverage refresh should resolve a Census place once per unique city
-- and state rather than repeating that index lookup for every lead in that
-- city. This keeps the consistency/backfill pass comfortably below the SQL API
-- timeout as the leads table grows.

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
                            AND pt.lng BETWEEN -180 AND 180)
    INTO v_active, v_placeable
    FROM placed_tech pt;

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
     WHERE coalesce(t.stored_lat, p.latitude) BETWEEN -90 AND 90
       AND coalesce(t.stored_lng, p.longitude) BETWEEN -180 AND 180
  ),
  parsed_lead AS MATERIALIZED (
    SELECT l.id,
           l.latitude AS stored_lat,
           l.longitude AS stored_lng,
           loc.city,
           loc.state,
           loc.zip_code
      FROM public.leads l
      CROSS JOIN LATERAL public.parse_lead_location(
        l.address, l.city, l.state, l.zip_code
      ) AS loc
     WHERE l.address IS NOT NULL OR l.city IS NOT NULL
        OR l.state IS NOT NULL OR l.zip_code IS NOT NULL
  ),
  places_to_resolve AS MATERIALIZED (
    SELECT DISTINCT city, state
      FROM parsed_lead
     WHERE city IS NOT NULL
  ),
  resolved_places AS MATERIALIZED (
    SELECT r.city, r.state, p.latitude, p.longitude
      FROM places_to_resolve r
      LEFT JOIN LATERAL public.us_place_coordinates(r.city, r.state) p ON true
  ),
  placed_lead AS MATERIALIZED (
    SELECT pl.id,
           CASE WHEN pl.stored_lat BETWEEN -90 AND 90
                     AND pl.stored_lng BETWEEN -180 AND 180
                THEN pl.stored_lat ELSE rp.latitude END AS lat,
           CASE WHEN pl.stored_lat BETWEEN -90 AND 90
                     AND pl.stored_lng BETWEEN -180 AND 180
                THEN pl.stored_lng ELSE rp.longitude END AS lng,
           pl.city,
           pl.state,
           pl.zip_code
      FROM parsed_lead pl
      LEFT JOIN resolved_places rp
        ON rp.city IS NOT DISTINCT FROM pl.city
       AND rp.state IS NOT DISTINCT FROM pl.state
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
     SET coverage_tech_count = CASE WHEN c.id IS NULL THEN NULL ELSE c.tech_count::integer END,
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
