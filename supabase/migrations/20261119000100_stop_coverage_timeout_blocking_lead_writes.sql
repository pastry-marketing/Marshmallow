-- =============================================================================
-- Migration: 20261119000100_stop_coverage_timeout_blocking_lead_writes.sql
-- Purpose: Make technician-coverage calculation never abort a lead INSERT or
--          UPDATE, and stop re-resolving every technician's area coordinates
--          on every single lead write.
-- Defect fixed: Customer Service reported "canceling statement due to statement
--               timeout" when adding leads from the Chrome extension and had to
--               retry two or three times. Postgres logs for this project show the
--               INSERT into public.leads failing inside
--               trg_lead_coverage_refresh -> refresh_lead_coverage ->
--               lead_technician_coverage -> calculate_lead_technician_coverage,
--               which on every insert re-derived coordinates for every distinct
--               active technician Area via technician_area_place() before doing a
--               40-mile count. With ~2.8k technicians the placement step alone
--               exceeded statement_timeout, so the whole INSERT was cancelled.
--               The lead was then not created, and the user retried.
-- Changes:
--   1. trg_lead_coverage_refresh() catches any error, so a slow or failing
--      coverage calculation can no longer fail the lead write. Coverage is
--      advisory metadata: a lead with no badge is recoverable by
--      recalculate_lead_coverage() or recalculate_all_lead_coverage(); a lost
--      lead is not.
--   2. A bounded local statement_timeout keeps one pathological placement from
--      holding the row lock and connection for the whole session timeout.
--   3. technician_area_place() reads a cache table first, so repeated inserts
--      stop re-running the name-normalization search for every technician Area.
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.technician_area_coordinate_cache;
--   -- then re-apply the pre-cache technician_area_place() body from
--   -- 20261110000000_coverage_preview_and_address_normalization.sql and the
--   -- pre-guard trg_lead_coverage_refresh() body from
--   -- 20261107000000_place_coverage_by_us_places.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Coordinate cache for technician Areas.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.technician_area_coordinate_cache (
  area_key    TEXT PRIMARY KEY,
  area        TEXT NOT NULL,
  city        TEXT,
  state_code  TEXT,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.technician_area_coordinate_cache IS
  'Resolved coordinates for technician Area strings, so lead coverage checks do not re-run place lookup for every Area on every lead write.';

ALTER TABLE public.technician_area_coordinate_cache ENABLE ROW LEVEL SECURITY;

-- Service role maintains this; the lead write path reads it inside SECURITY
-- DEFINER functions. No authenticated or anon access is granted.
REVOKE ALL ON public.technician_area_coordinate_cache FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.technician_area_coordinate_cache TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Cache-aware technician_area_place().
--    Unresolved Areas still fall back to the live lookup, so the cache can be
--    empty or incomplete without breaking coverage.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.technician_area_place(_area text)
 RETURNS TABLE(city text, state_code text, latitude double precision, longitude double precision)
 LANGUAGE plpgsql
 STABLE
 SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_text      text := btrim(coalesce(_area, ''));
  v_key       text;
  v_city      text;
  v_state     text;
  v_lat       double precision;
  v_lng       double precision;
  v_candidate text;
  v_stripped  text;
  v_state_name text;
  v_cached    boolean := false;
BEGIN
  IF v_text = '' THEN
    RETURN;
  END IF;

  -- One canonical key per spelling/casing/whitespace variant.
  v_key := regexp_replace(lower(v_text), '[^a-z0-9]+', '', 'g');

  SELECT c.city, c.state_code, c.latitude, c.longitude, true
    INTO v_city, v_state, v_lat, v_lng, v_cached
    FROM public.technician_area_coordinate_cache c
   WHERE c.area_key = v_key;

  IF v_cached THEN
    RETURN QUERY SELECT v_city, v_state, v_lat, v_lng;
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

REVOKE ALL ON FUNCTION public.technician_area_place(text) FROM PUBLIC, anon;

-- -----------------------------------------------------------------------------
-- 3. Populate the cache for every distinct active technician Area.
--    Idempotent, and safe to re-run after Areas are edited.
-- -----------------------------------------------------------------------------
INSERT INTO public.technician_area_coordinate_cache (area_key, area, city, state_code, latitude, longitude, resolved_at)
SELECT DISTINCT ON (regexp_replace(lower(btrim(coalesce(t.area, ''))), '[^a-z0-9]+', '', 'g'))
       regexp_replace(lower(btrim(coalesce(t.area, ''))), '[^a-z0-9]+', '', 'g') AS area_key,
       btrim(t.area)                                                   AS area,
       p.city, p.state_code, p.latitude, p.longitude,
       now()
  FROM public.technicians t
  CROSS JOIN LATERAL public.technician_area_place(t.area) p
 WHERE NULLIF(btrim(coalesce(t.area, '')), '') IS NOT NULL
 ORDER BY regexp_replace(lower(btrim(coalesce(t.area, ''))), '[^a-z0-9]+', '', 'g'),
          (p.latitude IS NOT NULL) DESC NULLS LAST
ON CONFLICT (area_key) DO UPDATE
   SET area        = EXCLUDED.area,
       city        = EXCLUDED.city,
       state_code  = EXCLUDED.state_code,
       latitude    = COALESCE(EXCLUDED.latitude, public.technician_area_coordinate_cache.latitude),
       longitude   = COALESCE(EXCLUDED.longitude, public.technician_area_coordinate_cache.longitude),
       resolved_at = now();

-- -----------------------------------------------------------------------------
-- 4. The lead write must never fail because of coverage.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_lead_coverage_refresh()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $fn$
BEGIN
  BEGIN
    -- A single slow placement must not hold this row and its connection until
    -- the session statement timeout. Five seconds is far above the cached path
    -- and far below any request the extension waits on.
    SET LOCAL statement_timeout = '5s';
    PERFORM public.refresh_lead_coverage(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Coverage is derived metadata. Losing the badge is recoverable with
    -- recalculate_lead_coverage(NEW.id) or recalculate_all_lead_coverage();
    -- failing the INSERT would lose the lead itself and force the user to retry.
    RAISE WARNING 'lead_coverage_refresh_skipped lead=%: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.trg_lead_coverage_refresh() FROM PUBLIC, anon;

-- -----------------------------------------------------------------------------
-- 5. Refresh the cache for Areas that changed. Admin only, idempotent.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_technician_area_coordinate_cache()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  WITH resolved AS (
    SELECT DISTINCT ON (regexp_replace(lower(btrim(coalesce(t.area, ''))), '[^a-z0-9]+', '', 'g'))
           regexp_replace(lower(btrim(coalesce(t.area, ''))), '[^a-z0-9]+', '', 'g') AS area_key,
           btrim(t.area) AS area,
           p.city, p.state_code, p.latitude, p.longitude
      FROM public.technicians t
      CROSS JOIN LATERAL public.technician_area_place(t.area) p
     WHERE NULLIF(btrim(coalesce(t.area, '')), '') IS NOT NULL
     ORDER BY regexp_replace(lower(btrim(coalesce(t.area, ''))), '[^a-z0-9]+', '', 'g'),
              (p.latitude IS NOT NULL) DESC NULLS LAST
  ), upserted AS (
    INSERT INTO public.technician_area_coordinate_cache (area_key, area, city, state_code, latitude, longitude, resolved_at)
    SELECT area_key, area, city, state_code, latitude, longitude, now() FROM resolved
    ON CONFLICT (area_key) DO UPDATE
       SET area        = EXCLUDED.area,
           city        = EXCLUDED.city,
           state_code  = EXCLUDED.state_code,
           latitude    = COALESCE(EXCLUDED.latitude, public.technician_area_coordinate_cache.latitude),
           longitude   = COALESCE(EXCLUDED.longitude, public.technician_area_coordinate_cache.longitude),
           resolved_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;

  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.refresh_technician_area_coordinate_cache() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_technician_area_coordinate_cache() TO authenticated;

COMMENT ON FUNCTION public.trg_lead_coverage_refresh() IS
  'AFTER trigger that refreshes lead technician coverage. Failures are logged as '
  'warnings and swallowed: coverage is advisory metadata and must never abort a '
  'lead INSERT or UPDATE.';