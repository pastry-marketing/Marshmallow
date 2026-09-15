-- Regular OPR users can add and edit technicians in their own OPR scope, but
-- deletion is reserved for OPR Admin. Existing Admin and Processor policies
-- continue to allow those roles to delete technicians.

DROP POLICY IF EXISTS "Operators can delete scoped technicians" ON public.technicians;
DROP POLICY IF EXISTS "OPR admins can delete technicians" ON public.technicians;

CREATE POLICY "OPR admins can delete technicians"
  ON public.technicians FOR DELETE TO authenticated
  USING (public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role));
