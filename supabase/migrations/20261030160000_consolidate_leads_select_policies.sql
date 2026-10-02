-- =============================================================================
-- Migration : 20261030160000_consolidate_leads_select_policies.sql
-- Purpose   : Close a row-level security bypass and replace three overlapping
--             SELECT policies with one that states the rule once.
--
-- THE BYPASS
--   public.leads has three permissive SELECT policies. PostgreSQL OR-s
--   permissive policies, so a row is visible when ANY one of them allows it.
--
--     A. "Scoped lead access"              CASE on role
--     B. "Users can view accessible leads"  ownership, or a broad role
--     C. "OPR admins can view leads"        opr_admin AND urgent_job
--
--   A deliberately withholds five statuses from a CS Admin:
--   paid, partial_paid, cancelled, job_done and scammed. B then hands the
--   same CS Admin any lead they created or are assigned, regardless of
--   status, so the withheld statuses come straight back through the other
--   policy and A's protection never applies to a lead that user happens to
--   own.
--
--   This is reachable, not theoretical: a CS creates a lead, marks it paid,
--   then assigns a CS Admin - who would then see a settled, already-paid
--   lead the rule exists to hide.
--
--   As of 2026-09-30 no CS Admin owns a lead in one of those five statuses,
--   so nothing is exposed today. That is luck, not design.
--
-- WHAT IS DELIBERATELY NOT CHANGED
--   Policy B also lets any user see a lead they own even when its status is
--   scammed, where A says never. 17 leads are scammed and 8 of them are owned
--   by a Customer Service user, so dropping that clause would silently hide 8
--   real leads from the people who own them. Whether a CS should see a
--   scammed lead they own is a product decision, not a security fix, so it is
--   preserved exactly as it is today and raised separately.
--
-- THE NEW POLICY
--   One policy, one statement of the rule. Every role keeps precisely the
--   visibility it has today, and the CS Admin case is the only thing that
--   moves - from "own leads plus everything except five statuses" to
--   "everything except five statuses", which is what A always intended.
--
--   The ownership clause is now guarded so it cannot apply to a role that has
--   an explicit rule above it. That guard is the whole fix: without it the
--   bypass simply moves inside the new policy.
--
-- PERFORMANCE
--   has_role() is SECURITY DEFINER and cannot be inlined, so it costs a call
--   per invocation. The old arrangement evaluated up to three policies per
--   row, each calling has_role. One policy short-circuits on the first match,
--   so this is not a regression and is usually fewer calls than before.
--
-- VERIFYING THIS IS SAFE
--   Run supabase/tests/40_leads_rls_baseline.sql BEFORE applying this, and
--   keep its grid. Run it again afterwards and diff. Every row must match
--   except the CS Admin row, which is expected to shrink. If any other row
--   moves, stop and roll back.
--
-- ROLLBACK
--   The three original policies are restored verbatim at the bottom of this
--   file.
-- =============================================================================

-- Preserved once, so the ownership test is written the same way everywhere
-- inside this policy.
CREATE OR REPLACE FUNCTION public.leads_owned_by_caller(_lead public.leads)
RETURNS boolean
LANGUAGE sql
STABLE
AS $fn$
  SELECT _lead.created_by = auth.uid()
      OR _lead.assigned_cs = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.lead_shares s
         WHERE s.lead_id = _lead.id
           AND s.shared_with_user_id = auth.uid()
      );
$fn$;

COMMENT ON FUNCTION public.leads_owned_by_caller(public.leads) IS
  'Whether the caller created, is assigned to, or has been shared the lead. '
  'Used by the consolidated leads SELECT policy.';


DROP POLICY IF EXISTS "Users can view accessible leads" ON public.leads;
DROP POLICY IF EXISTS "OPR admins can view leads" ON public.leads;
DROP POLICY IF EXISTS "Scoped lead access" ON public.leads;

CREATE POLICY "Lead visibility by role"
  ON public.leads
  FOR SELECT
  TO authenticated
USING (
    -- Admin, Processor and OPR have always seen every lead.
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'processor'::app_role)
    OR has_role(auth.uid(), 'opr'::app_role)

    -- OPR Admin: urgent jobs, plus their own leads that are not scammed.
    OR (
      has_role(auth.uid(), 'opr_admin'::app_role)
      AND (
        status = 'urgent_job'::text
        OR (status <> 'scammed'::text AND public.leads_owned_by_caller(leads.*))
      )
    )

    -- CS Admin: every status except the settled or blocked five. Ownership is
    -- deliberately NOT allowed in here. Allowing it is what let a CS Admin see
    -- a paid or cancelled lead they happened to own.
    OR (
      has_role(auth.uid(), 'cs_admin'::app_role)
      AND status <> ALL (ARRAY[
        'paid'::text, 'partial_paid'::text, 'cancelled'::text,
        'job_done'::text, 'scammed'::text
      ])
    )

    -- Everyone else, and any role with no rule above: their own leads only.
    -- The guard is what stops the bypass reappearing inside this policy.
    OR (
      NOT (
        has_role(auth.uid(), 'admin'::app_role)
        OR has_role(auth.uid(), 'processor'::app_role)
        OR has_role(auth.uid(), 'opr'::app_role)
        OR has_role(auth.uid(), 'opr_admin'::app_role)
        OR has_role(auth.uid(), 'cs_admin'::app_role)
      )
      AND public.leads_owned_by_caller(leads.*)
    )
);


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP POLICY IF EXISTS "Lead visibility by role" ON public.leads;
--   DROP FUNCTION IF EXISTS public.leads_owned_by_caller(public.leads);
--
--   CREATE POLICY "Scoped lead access"
--     ON public.leads FOR SELECT TO authenticated
--   USING (
--     CASE
--       WHEN has_role(auth.uid(), 'admin'::app_role) THEN true
--       WHEN has_role(auth.uid(), 'processor'::app_role) THEN true
--       WHEN has_role(auth.uid(), 'opr'::app_role) THEN true
--       WHEN has_role(auth.uid(), 'cs_admin'::app_role)
--         THEN (status <> ALL (ARRAY['paid'::text,'partial_paid'::text,'cancelled'::text,'job_done'::text,'scammed'::text]))
--       ELSE ((status <> 'scammed'::text) AND ((created_by = auth.uid()) OR (assigned_cs = auth.uid()) OR (EXISTS (
--         SELECT 1 FROM lead_shares
--          WHERE lead_shares.lead_id = leads.id
--            AND lead_shares.shared_with_user_id = auth.uid()))))
--     END
--   );
--
--   CREATE POLICY "Users can view accessible leads"
--     ON public.leads FOR SELECT TO authenticated
--   USING (
--     ((created_by = auth.uid()) OR (assigned_cs = auth.uid())
--      OR has_role(auth.uid(), 'admin'::app_role)
--      OR has_role(auth.uid(), 'processor'::app_role)
--      OR has_role(auth.uid(), 'opr'::app_role)
--      OR (EXISTS (
--         SELECT 1 FROM lead_shares
--          WHERE lead_shares.lead_id = leads.id
--            AND lead_shares.shared_with_user_id = auth.uid()))))
--   );
--
--   CREATE POLICY "OPR admins can view leads"
--     ON public.leads FOR SELECT TO authenticated
--   USING ((has_role(auth.uid(), 'opr_admin'::app_role) AND (status = 'urgent_job'::text)));
--
-- This migration alters no lead row, so the rollback above is complete.
-- =============================================================================