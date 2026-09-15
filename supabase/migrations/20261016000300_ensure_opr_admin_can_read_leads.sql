-- Add OPR Admin urgent-lead visibility without changing any existing role policy.
-- PostgreSQL combines permissive SELECT policies with OR, so status visibility
-- remains controlled by the CRM after these rows are returned.
DROP POLICY IF EXISTS "OPR admins can view leads" ON public.leads;

CREATE POLICY "OPR admins can view leads"
  ON public.leads
  FOR SELECT
  TO authenticated
  USING (
    public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role)
    AND status = 'urgent_job'
  );
