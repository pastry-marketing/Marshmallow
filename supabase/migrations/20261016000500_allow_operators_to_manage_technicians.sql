-- Let operators manage the technician rows that belong to their OPR scope.
-- Existing Admin and Processor policies remain in place.

CREATE OR REPLACE FUNCTION public.current_user_opr_code()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT upper(nullif(btrim(p.opr_code), ''))
  FROM public.profiles AS p
  WHERE p.id = (SELECT auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.is_assigned_opr_code(_opr_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE upper(nullif(btrim(p.opr_code), '')) = upper(nullif(btrim(_opr_code), ''))
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_opr_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_assigned_opr_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_opr_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_assigned_opr_code(text) TO authenticated;

DROP POLICY IF EXISTS "Operators can view scoped technicians" ON public.technicians;
CREATE POLICY "Operators can view scoped technicians"
  ON public.technicians FOR SELECT TO authenticated
  USING (
    (
      public.has_role((SELECT auth.uid()), 'opr'::public.app_role)
      AND upper(nullif(btrim(opr_code), '')) = (SELECT public.current_user_opr_code())
    )
    OR (
      public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role)
      AND nullif(btrim(opr_code), '') IS NOT NULL
    )
  );

DROP POLICY IF EXISTS "Operators can insert scoped technicians" ON public.technicians;
CREATE POLICY "Operators can insert scoped technicians"
  ON public.technicians FOR INSERT TO authenticated
  WITH CHECK (
    (
      public.has_role((SELECT auth.uid()), 'opr'::public.app_role)
      AND (SELECT public.current_user_opr_code()) IS NOT NULL
      AND upper(nullif(btrim(opr_code), '')) = (SELECT public.current_user_opr_code())
    )
    OR (
      public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role)
      AND (SELECT public.is_assigned_opr_code(opr_code))
    )
  );

DROP POLICY IF EXISTS "Operators can update scoped technicians" ON public.technicians;
CREATE POLICY "Operators can update scoped technicians"
  ON public.technicians FOR UPDATE TO authenticated
  USING (
    (
      public.has_role((SELECT auth.uid()), 'opr'::public.app_role)
      AND upper(nullif(btrim(opr_code), '')) = (SELECT public.current_user_opr_code())
    )
    OR (
      public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role)
      AND nullif(btrim(opr_code), '') IS NOT NULL
    )
  )
  WITH CHECK (
    (
      public.has_role((SELECT auth.uid()), 'opr'::public.app_role)
      AND (SELECT public.current_user_opr_code()) IS NOT NULL
      AND upper(nullif(btrim(opr_code), '')) = (SELECT public.current_user_opr_code())
    )
    OR (
      public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role)
      AND (SELECT public.is_assigned_opr_code(opr_code))
    )
  );

DROP POLICY IF EXISTS "Operators can delete scoped technicians" ON public.technicians;
CREATE POLICY "Operators can delete scoped technicians"
  ON public.technicians FOR DELETE TO authenticated
  USING (
    (
      public.has_role((SELECT auth.uid()), 'opr'::public.app_role)
      AND upper(nullif(btrim(opr_code), '')) = (SELECT public.current_user_opr_code())
    )
    OR (
      public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role)
      AND nullif(btrim(opr_code), '') IS NOT NULL
    )
  );
