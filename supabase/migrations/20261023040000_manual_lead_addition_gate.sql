-- =============================================================================
-- Migration : 20261023040000_manual_lead_addition_gate.sql
-- Purpose   : Gate manual lead creation behind an explicit per-user privilege,
--             replacing the `auth.uid() IS NOT NULL` hole on public.leads.
--
-- WHAT THIS DOES
--   1. profiles.can_add_manual_leads  - the "Manual Lead Addition" grant
--   2. leads.manual_entry             - marks rows created through the CRM UI
--                                        (Chrome extension leaves it false)
--   3. public.can_create_manual_lead()
--                                    - admin OR cs_admin OR (cs WITH the grant)
--   4. Replaces BOTH leads INSERT policies with one that requires
--      created_by = auth.uid() AND (manual_entry = false OR can_create_manual_lead())
--   5. public.protect_profile_privilege_flags()
--                                    - BEFORE INSERT OR UPDATE trigger that stops
--                                      a non-admin from self-granting any of the
--                                      four privilege columns (profiles RLS is
--                                      `id = auth.uid()` with no column limit)
--   6. public.manual_lead_access()
--                                    - narrow read RPC so CS Admin can see the
--                                      flag (profiles_public only exposes
--                                      id, full_name)
--   7. public.set_can_add_manual_leads()
--                                    - narrow write RPC. profiles UPDATE RLS is
--                                      admin-only, so a CS Admin has no
--                                      table-level way to grant the flag.
--
-- LAYERS COVERED (GEMINI.md all-layer rule)
--   frontend UI   : LeadsPage / GlobalCommandMenu / Settings switches / docs
--   frontend perms: src/lib/access.ts :: canAddManualLead()
--   RLS           : leads INSERT policy replaced (below)
--   edge funcs    : no edge function inserts leads (verified)
--   types         : regenerated from schema, never hand-edited
--
-- -----------------------------------------------------------------------------
-- ROLLBACK - run this block verbatim to undo everything below it.
-- -----------------------------------------------------------------------------
/*
DROP POLICY IF EXISTS "Lead creators can insert their own leads" ON public.leads;

-- verbatim restore of the two live policies captured from pg_policies on
-- project kxiqholnmhkwhdkhtopp before this migration was applied:
CREATE POLICY "Authenticated can insert leads" ON public.leads
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (( SELECT auth.uid() AS uid) IS NOT NULL);

CREATE POLICY "CS Admins can create their own leads" ON public.leads
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((created_by = auth.uid()) AND has_role(auth.uid(), 'cs_admin'::app_role));

DROP FUNCTION IF EXISTS public.manual_lead_access();
DROP FUNCTION IF EXISTS public.set_can_add_manual_leads(uuid, boolean);
DROP TRIGGER IF EXISTS protect_profile_privilege_flags ON public.profiles;
DROP FUNCTION IF EXISTS public.protect_profile_privilege_flags();
DROP FUNCTION IF EXISTS public.can_create_manual_lead();

ALTER TABLE public.leads  DROP COLUMN IF EXISTS manual_entry;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS can_add_manual_leads;
*/
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1 + 2 : privilege column and manual-entry marker
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_add_manual_leads boolean NOT NULL DEFAULT false;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS manual_entry boolean NOT NULL DEFAULT false;


-- -----------------------------------------------------------------------------
-- 3 : the single source of truth for "may this user create a manual lead?"
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_create_manual_lead()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'cs_admin'::public.app_role)
      OR (
           public.has_role(auth.uid(), 'customer_service'::public.app_role)
           AND EXISTS (
             SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid()
               AND p.can_add_manual_leads
           )
         );
$$;

REVOKE EXECUTE ON FUNCTION public.can_create_manual_lead() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.can_create_manual_lead() FROM anon;
GRANT  EXECUTE ON FUNCTION public.can_create_manual_lead() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.can_create_manual_lead() TO service_role;


-- -----------------------------------------------------------------------------
-- 4 : replace both leads INSERT policies with the gated one
--     RLS WITH CHECK may reference new-row columns (existing precedent:
--     "CS Admins can create their own leads" already reads created_by).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated can insert leads" ON public.leads;
DROP POLICY IF EXISTS "authenticated can insert leads" ON public.leads;
DROP POLICY IF EXISTS "CS Admins can create their own leads" ON public.leads;
DROP POLICY IF EXISTS "Lead creators can insert their own leads" ON public.leads;

CREATE POLICY "Lead creators can insert their own leads" ON public.leads
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (
      manual_entry = false
      OR public.can_create_manual_lead()
    )
  );


-- -----------------------------------------------------------------------------
-- 5 : block self-service escalation of privilege flags
--     RLS on profiles is "Users can update own profile" (USING id = auth.uid(),
--     no column restriction) plus "Admins can update profiles", so a non-admin
--     can already rewrite their own row - this trigger is what stops them
--     flipping a grant. The only non-admin path that is allowed through is a
--     CS Admin with can_manage_users granting Manual Lead Addition to a
--     Customer Service user other than themselves.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_privilege_flags()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_can_manage boolean;
BEGIN
  -- Trusted non-user paths: service_role (no JWT) runs the admin-users edge
  -- function. Anonymous users already cannot UPDATE profiles (RLS denies them).
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.has_role(v_caller, 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.can_add_manual_leads
       OR NEW.can_manage_users
       OR NEW.is_quotation_master
       OR NEW.can_view_tech_report THEN
      RAISE EXCEPTION 'Not permitted to set privilege flags';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.can_add_manual_leads   IS NOT DISTINCT FROM OLD.can_add_manual_leads
     AND NEW.can_manage_users   IS NOT DISTINCT FROM OLD.can_manage_users
     AND NEW.is_quotation_master IS NOT DISTINCT FROM OLD.is_quotation_master
     AND NEW.can_view_tech_report IS NOT DISTINCT FROM OLD.can_view_tech_report THEN
    RETURN NEW;
  END IF;

  -- has_role() is EXISTS-based, so it stays correct if a user later holds more
  -- than one role (user_roles is unique on (user_id, role), not on user_id).
  SELECT can_manage_users INTO v_can_manage FROM public.profiles WHERE id = v_caller;

  IF public.has_role(v_caller, 'cs_admin'::public.app_role)
     AND v_can_manage IS TRUE
     AND public.has_role(NEW.id, 'customer_service'::public.app_role)
     AND NEW.id <> v_caller
     AND NEW.can_add_manual_leads IS DISTINCT FROM OLD.can_add_manual_leads
     AND NEW.can_manage_users    IS NOT DISTINCT FROM OLD.can_manage_users
     AND NEW.is_quotation_master IS NOT DISTINCT FROM OLD.is_quotation_master
     AND NEW.can_view_tech_report IS NOT DISTINCT FROM OLD.can_view_tech_report THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Not permitted to change privilege flags';
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_privilege_flags ON public.profiles;
CREATE TRIGGER protect_profile_privilege_flags
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_privilege_flags();


-- -----------------------------------------------------------------------------
-- 6 : narrow read RPC for CS Admin / Admin
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.manual_lead_access()
RETURNS TABLE (user_id uuid, can_add_manual_leads boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.can_add_manual_leads
  FROM public.profiles p
  WHERE public.has_role(auth.uid(), 'admin'::public.app_role)
     OR public.has_role(auth.uid(), 'cs_admin'::public.app_role);
$$;

REVOKE EXECUTE ON FUNCTION public.manual_lead_access() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manual_lead_access() FROM anon;
GRANT  EXECUTE ON FUNCTION public.manual_lead_access() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.manual_lead_access() TO service_role;


-- -----------------------------------------------------------------------------
-- 7 : write RPC
--      profiles UPDATE RLS is admin-only ("Admins can update profiles"), so a
--      CS Admin has no table-level way to grant this. SECURITY DEFINER runs as
--      the owner (which bypasses RLS) and re-checks the caller itself; the
--      protect_profile_privilege_flags trigger is the backstop for anyone who
--      reaches the table directly.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_can_add_manual_leads(target_user_id uuid, allowed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_can_manage boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- has_role() is EXISTS-based: correct under multiple roles per user.
  SELECT can_manage_users INTO v_can_manage FROM public.profiles WHERE id = v_caller;

  IF NOT (
    public.has_role(v_caller, 'admin'::public.app_role)
    OR (
      public.has_role(v_caller, 'cs_admin'::public.app_role)
      AND v_can_manage IS TRUE
      AND public.has_role(target_user_id, 'customer_service'::public.app_role)
      AND target_user_id <> v_caller
    )
  ) THEN
    RAISE EXCEPTION 'Not permitted to change Manual Lead Addition';
  END IF;

  UPDATE public.profiles SET can_add_manual_leads = allowed WHERE id = target_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_can_add_manual_leads(uuid, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_can_add_manual_leads(uuid, boolean) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_can_add_manual_leads(uuid, boolean) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.set_can_add_manual_leads(uuid, boolean) TO service_role;
