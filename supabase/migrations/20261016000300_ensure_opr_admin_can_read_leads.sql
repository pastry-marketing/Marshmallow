-- Keep lead row access aligned for OPR and OPR Admin. Status visibility is
-- applied in the CRM after RLS returns the rows.
DROP POLICY IF EXISTS "Scoped lead access" ON public.leads;
DROP POLICY IF EXISTS "Users can view accessible leads" ON public.leads;

CREATE POLICY "Users can view accessible leads"
  ON public.leads
  FOR SELECT
  TO authenticated
  USING (
    CASE
      WHEN public.has_role((SELECT auth.uid()), 'admin'::public.app_role) THEN TRUE
      WHEN public.has_role((SELECT auth.uid()), 'processor'::public.app_role) THEN TRUE
      WHEN public.has_role((SELECT auth.uid()), 'opr'::public.app_role) THEN TRUE
      WHEN public.has_role((SELECT auth.uid()), 'opr_admin'::public.app_role) THEN TRUE
      WHEN public.has_role((SELECT auth.uid()), 'cs_admin'::public.app_role) THEN
        status NOT IN ('paid', 'partial_paid', 'cancelled', 'job_done', 'scammed')
      ELSE
        status <> 'scammed'
        AND (
          created_by = (SELECT auth.uid())
          OR assigned_cs = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1
            FROM public.lead_shares
            WHERE lead_shares.lead_id = leads.id
              AND lead_shares.shared_with_user_id = (SELECT auth.uid())
          )
        )
    END
  );
