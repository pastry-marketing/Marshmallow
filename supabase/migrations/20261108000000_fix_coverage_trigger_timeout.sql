-- Avoid running a full technician coverage calculation on every lead save, and
-- reuse each distinct technician Area placement during a real location change.
-- The old per-lead function resolved all 2,830 active technician rows twice;
-- measured against production, that took 18.6 seconds and exceeded the normal
-- PostgREST statement timeout.

CREATE INDEX IF NOT EXISTS us_places_state_name_idx
  ON public.us_places (state_code, name) INCLUDE (state_name);

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
      FROM public.us_places p
     WHERE lower(p.name) = lower(btrim(v_city))
       AND (v_state IS NULL OR p.state_code = v_state)
     ORDER BY p.population DESC, p.name
     LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    RETURN;
  END IF;

  -- Resolve a free-text Area once per distinct value, and never resolve it for
  -- a technician who already has a valid coordinate pair. The materialized CTE
  -- is then shared by both the roster validity counts and the distance count.
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

COMMENT ON FUNCTION public.lead_technician_coverage(uuid) IS
  'Active technicians within 40 miles of a lead. Resolves each distinct free-text '
  'technician Area once per calculation; returns no row for an unplaceable lead '
  'or a nonempty unplaceable roster.';

-- INSERTs always need an initial calculation. UPDATEs recalculate only when at
-- least one location input actually changes; regular lead saves commonly include
-- address fields in their payload even when the address itself was not edited.
DROP TRIGGER IF EXISTS leads_refresh_coverage ON public.leads;
DROP TRIGGER IF EXISTS leads_refresh_coverage_insert ON public.leads;
DROP TRIGGER IF EXISTS leads_refresh_coverage_location_update ON public.leads;

CREATE TRIGGER leads_refresh_coverage_insert
  AFTER INSERT ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_lead_coverage_refresh();

CREATE TRIGGER leads_refresh_coverage_location_update
  AFTER UPDATE OF address, city, state, zip_code, latitude, longitude
  ON public.leads
  FOR EACH ROW
  WHEN (
    OLD.address IS DISTINCT FROM NEW.address
    OR OLD.city IS DISTINCT FROM NEW.city
    OR OLD.state IS DISTINCT FROM NEW.state
    OR OLD.zip_code IS DISTINCT FROM NEW.zip_code
    OR OLD.latitude IS DISTINCT FROM NEW.latitude
    OR OLD.longitude IS DISTINCT FROM NEW.longitude
  )
  EXECUTE FUNCTION public.trg_lead_coverage_refresh();
