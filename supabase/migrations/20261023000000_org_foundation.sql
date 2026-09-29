-- ============================================================================
-- Migration: 20261023000000_org_foundation.sql
-- Description: Multi-tenant organization foundation, default org seeding,
--              instant zero-rewrite leads.org_id column with default,
--              helper functions, and scoped RLS policies.
--
-- Rollback Instructions:
-- 1. DROP POLICY IF EXISTS "Members can select their own organization" ON public.organizations;
-- 2. DROP POLICY IF EXISTS "Admins have full access to organizations" ON public.organizations;
-- 3. DROP POLICY IF EXISTS "Members can select their own membership rows" ON public.organization_members;
-- 4. DROP POLICY IF EXISTS "Admins have full access to organization_members" ON public.organization_members;
-- 5. DROP FUNCTION IF EXISTS public.org_role(uuid);
-- 6. DROP FUNCTION IF EXISTS public.is_org_member(uuid);
-- 7. ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_org_id_fkey;
-- 8. DROP INDEX IF EXISTS public.idx_leads_org_id;
-- 9. ALTER TABLE public.leads DROP COLUMN IF EXISTS org_id;
-- 10. DROP TABLE IF EXISTS public.organization_members;
-- 11. DROP TABLE IF EXISTS public.organizations;
-- 12. DROP FUNCTION IF EXISTS public.default_org_id();
-- ============================================================================

-- 1. Fixed Default Org Function
-- Returns the deterministic default organization UUID.
-- Granted to anon because column defaults are evaluated under the inserting role's context.
CREATE OR REPLACE FUNCTION public.default_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT 'a0000000-0000-0000-0000-000000000001'::uuid;
$$;

REVOKE ALL ON FUNCTION public.default_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.default_org_id() TO anon, authenticated, service_role;

-- 2. Organizations Table
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Organization Members Table
CREATE TABLE IF NOT EXISTS public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('org_admin', 'operator', 'client_viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user_id 
  ON public.organization_members(user_id);

CREATE INDEX IF NOT EXISTS idx_organization_members_org_id 
  ON public.organization_members(org_id);

-- 4. Seed Default Organization (ON CONFLICT DO NOTHING)
INSERT INTO public.organizations (id, name, slug, is_active)
VALUES (
  public.default_org_id(),
  'Default Organization',
  'default',
  true
)
ON CONFLICT (id) DO NOTHING;

-- 5. Scope leads to organizations (Zero table-rewrite single statement)
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL
  DEFAULT public.default_org_id()
  REFERENCES public.organizations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_leads_org_id ON public.leads(org_id);

-- 6. Helper Functions (Security Definer, clean search_path, scalar subqueries)
CREATE OR REPLACE FUNCTION public.is_org_member(_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members AS om
    WHERE om.org_id = _org_id
      AND om.user_id = (SELECT auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_org_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.org_role(_org_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT om.role
  FROM public.organization_members AS om
  WHERE om.org_id = _org_id
    AND om.user_id = (SELECT auth.uid())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.org_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_role(uuid) TO authenticated, service_role;

-- 7. Enable RLS on organizations and organization_members
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

-- 8. RLS Policies on organizations
DROP POLICY IF EXISTS "Admins have full access to organizations" ON public.organizations;
CREATE POLICY "Admins have full access to organizations"
  ON public.organizations
  FOR ALL
  TO authenticated
  USING (
    public.has_role((SELECT auth.uid()), 'admin'::public.app_role)
  )
  WITH CHECK (
    public.has_role((SELECT auth.uid()), 'admin'::public.app_role)
  );

DROP POLICY IF EXISTS "Members can select their own organization" ON public.organizations;
CREATE POLICY "Members can select their own organization"
  ON public.organizations
  FOR SELECT
  TO authenticated
  USING (
    public.is_org_member(id)
  );

-- 9. RLS Policies on organization_members
DROP POLICY IF EXISTS "Admins have full access to organization_members" ON public.organization_members;
CREATE POLICY "Admins have full access to organization_members"
  ON public.organization_members
  FOR ALL
  TO authenticated
  USING (
    public.has_role((SELECT auth.uid()), 'admin'::public.app_role)
  )
  WITH CHECK (
    public.has_role((SELECT auth.uid()), 'admin'::public.app_role)
  );

DROP POLICY IF EXISTS "Members can select their own membership rows" ON public.organization_members;
CREATE POLICY "Members can select their own membership rows"
  ON public.organization_members
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
  );

-- 10. Explicit Table Grants
REVOKE ALL ON public.organizations FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;

REVOKE ALL ON public.organization_members FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
GRANT ALL ON public.organization_members TO service_role;
