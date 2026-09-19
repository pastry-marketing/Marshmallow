CREATE TABLE IF NOT EXISTS public.map_coverage_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '',
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_miles double precision NOT NULL CHECK (radius_miles > 0 AND radius_miles <= 3000),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS map_coverage_areas_active_name_idx
  ON public.map_coverage_areas (is_active DESC, name ASC, created_at ASC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.map_coverage_areas TO authenticated;
GRANT ALL ON public.map_coverage_areas TO service_role;

ALTER TABLE public.map_coverage_areas ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_manage_map_coverage(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.has_role(_user_id, 'admin'::public.app_role) THEN true
    WHEN EXISTS (
      SELECT 1
      FROM public.navigation_permissions AS np
      WHERE np.user_id = _user_id
        AND np.nav_section = 'map_view'
    ) THEN COALESCE((
      SELECT np.allowed
      FROM public.navigation_permissions AS np
      WHERE np.user_id = _user_id
        AND np.nav_section = 'map_view'
      LIMIT 1
    ), false)
    ELSE public.has_role(_user_id, 'processor'::public.app_role)
  END;
$$;

REVOKE ALL ON FUNCTION public.can_manage_map_coverage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_map_coverage(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Map roles can view coverage areas" ON public.map_coverage_areas;
CREATE POLICY "Map roles can view coverage areas"
  ON public.map_coverage_areas FOR SELECT TO authenticated
  USING (public.can_manage_map_coverage((SELECT auth.uid())));

DROP POLICY IF EXISTS "Map roles can create coverage areas" ON public.map_coverage_areas;
CREATE POLICY "Map roles can create coverage areas"
  ON public.map_coverage_areas FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND public.can_manage_map_coverage((SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "Map roles can update coverage areas" ON public.map_coverage_areas;
CREATE POLICY "Map roles can update coverage areas"
  ON public.map_coverage_areas FOR UPDATE TO authenticated
  USING (public.can_manage_map_coverage((SELECT auth.uid())))
  WITH CHECK (public.can_manage_map_coverage((SELECT auth.uid())));

DROP POLICY IF EXISTS "Map roles can delete coverage areas" ON public.map_coverage_areas;
CREATE POLICY "Map roles can delete coverage areas"
  ON public.map_coverage_areas FOR DELETE TO authenticated
  USING (public.can_manage_map_coverage((SELECT auth.uid())));

DROP TRIGGER IF EXISTS update_map_coverage_areas_updated_at ON public.map_coverage_areas;
CREATE TRIGGER update_map_coverage_areas_updated_at
  BEFORE UPDATE ON public.map_coverage_areas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'map_coverage_areas'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.map_coverage_areas';
  END IF;
END $$;
