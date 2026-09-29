-- =============================================================================
-- Manual test harness: Manual Lead Addition gate + RLS hardening
--
-- HOW TO RUN
--   Paste this whole file into the Supabase SQL Editor and run it as `postgres`.
--   Nothing persists: the file opens a transaction and ROLLBACKs at the end.
--
-- WHAT IT PRINTS
--   Structured checks (schema / grants / policies) run as postgres and end in a
--   final summary row per check:  PASS: <label>   or   FAIL: <label>.
--   Behaviour checks switch to a temporary `authenticated` / `anon` session and
--   report via   NOTICE: PASS: <label>   /   NOTICE: FAIL: <label>.
--   Grep for "FAIL". An empty result set plus PASS notices means green.
--
-- These are plain SQL assertions, deliberately NOT part of a migration.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _checks (ok boolean NOT NULL, label text NOT NULL) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.assert(p_ok boolean, p_label text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO _checks VALUES (COALESCE(p_ok, false), p_label);
END;
$$;

-- Synthetic identity, materialised in section 5 and rolled back with the rest:
--   00000000-0000-4000-8000-0000000000ff
-- One auth.users row is enough: handle_new_user() creates the matching
-- public.profiles row, and nothing creates a user_roles row, so the identity
-- stays role-less - the worst case for every guard below. The row must exist
-- because leads.created_by -> profiles(id) is a real FK, otherwise the
-- "extension path is allowed" insert would fail on the FK rather than on RLS.
-- The email is mandatory: profiles.email is NOT NULL and handle_new_user()
-- copies NEW.email across verbatim, so a bare id is rejected with 23502.

-- -----------------------------------------------------------------------------
-- 1. Schema
-- -----------------------------------------------------------------------------
SELECT pg_temp.assert(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'can_add_manual_leads' AND data_type = 'boolean'
  ),
  'profiles.can_add_manual_leads exists (boolean)'
);

SELECT pg_temp.assert(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'leads'
       AND column_name = 'manual_entry' AND data_type = 'boolean'
  ),
  'leads.manual_entry exists (boolean)'
);

SELECT pg_temp.assert(
  (SELECT is_nullable = 'NO' AND column_default = 'false'
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'can_add_manual_leads'),
  'profiles.can_add_manual_leads defaults to false and is NOT NULL'
);

SELECT pg_temp.assert(
  (SELECT is_nullable = 'NO' AND column_default = 'false'
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads'
      AND column_name = 'manual_entry'),
  'leads.manual_entry defaults to false and is NOT NULL'
);

-- -----------------------------------------------------------------------------
-- 2. Grants: anon must not reach any of the new or newly-revoked functions
-- -----------------------------------------------------------------------------
SELECT pg_temp.assert(
  NOT has_function_privilege('anon', 'public.can_create_manual_lead()', 'EXECUTE'),
  'anon CANNOT execute can_create_manual_lead()'
);
SELECT pg_temp.assert(
  NOT has_function_privilege('anon', 'public.manual_lead_access()', 'EXECUTE'),
  'anon CANNOT execute manual_lead_access()'
);
SELECT pg_temp.assert(
  NOT has_function_privilege('anon', 'public.set_can_add_manual_leads(uuid, boolean)', 'EXECUTE'),
  'anon CANNOT execute set_can_add_manual_leads()'
);
SELECT pg_temp.assert(
  NOT has_function_privilege('anon', 'public.delete_lead_by_admin(uuid)', 'EXECUTE'),
  'anon CANNOT execute delete_lead_by_admin()   <-- P0'
);
SELECT pg_temp.assert(
  NOT has_function_privilege('anon', 'public.has_role(uuid, app_role)', 'EXECUTE'),
  'anon CANNOT execute has_role(uuid, app_role)'
);
SELECT pg_temp.assert(
  NOT has_function_privilege('anon', 'public.has_role(uuid, app_role_old)', 'EXECUTE'),
  'anon CANNOT execute has_role(uuid, app_role_old)'
);
SELECT pg_temp.assert(
  NOT has_function_privilege('anon', 'public.assign_next_opr_code(uuid)', 'EXECUTE'),
  'anon CANNOT execute assign_next_opr_code()'
);

SELECT pg_temp.assert(
  has_function_privilege('authenticated', 'public.can_create_manual_lead()', 'EXECUTE'),
  'authenticated CAN execute can_create_manual_lead()'
);
SELECT pg_temp.assert(
  has_function_privilege('authenticated', 'public.manual_lead_access()', 'EXECUTE'),
  'authenticated CAN execute manual_lead_access()'
);
SELECT pg_temp.assert(
  has_function_privilege('authenticated', 'public.set_can_add_manual_leads(uuid, boolean)', 'EXECUTE'),
  'authenticated CAN execute set_can_add_manual_leads()'
);
SELECT pg_temp.assert(
  has_function_privilege('authenticated', 'public.has_role(uuid, app_role)', 'EXECUTE'),
  'authenticated CAN still execute has_role(uuid, app_role)'
);
SELECT pg_temp.assert(
  has_function_privilege('authenticated', 'public.delete_lead_by_admin(uuid)', 'EXECUTE'),
  'authenticated CAN still execute delete_lead_by_admin()'
);
SELECT pg_temp.assert(
  has_function_privilege('service_role', 'public.delete_lead_by_admin(uuid)', 'EXECUTE'),
  'service_role CAN still execute delete_lead_by_admin()'
);

-- -----------------------------------------------------------------------------
-- 3. Policies
-- -----------------------------------------------------------------------------
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'leads'
       AND policyname IN ('Authenticated can insert leads', 'CS Admins can create their own leads')
  ),
  'the two legacy leads INSERT policies are gone'
);

SELECT pg_temp.assert(
  EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'leads'
       AND policyname = 'Lead creators can insert their own leads'
       AND cmd = 'INSERT'
       AND roles = ARRAY['authenticated']::name[]
  ),
  'gated leads INSERT policy exists, scoped to authenticated'
);

SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'leads' AND cmd = 'INSERT') = 1,
  'exactly one leads INSERT policy remains'
);

SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND roles = ARRAY['public']::name[]
       AND tablename IN ('calls', 'lead_cancellation_requests', 'lead_notes',
                         'lead_shares', 'lead_updates', 'profiles')
  ),
  'the six former TO public policies are now scoped to authenticated'
);

SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'lead_payments'
             AND policyname = 'Lead payments require lead access'),
  'lead_payments INSERT now requires lead access'
);

SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'quo_conversation_flags'
             AND policyname = 'Gated insert on quo_conversation_flags')
  AND EXISTS (SELECT 1 FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'quo_conversation_flags'
             AND policyname = 'Gated update on quo_conversation_flags'),
  'quo_conversation_flags INSERT/UPDATE are gated by can_access_quo_ai()'
);

SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND cmd = 'INSERT') = 1
  AND EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'profiles'
                 AND cmd = 'INSERT' AND policyname = 'Users can insert own profile'),
  'profiles still has exactly one INSERT policy (the trigger guards the flags)'
);

SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'profiles'
             AND column_name = 'can_add_manual_leads'),
  'profiles column is present for the profiles INSERT policy to read'
);

SELECT pg_temp.assert(
  EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.profiles'::regclass
       AND tgname = 'protect_profile_privilege_flags'
       AND NOT tgisinternal
  ),
  'protect_profile_privilege_flags trigger is installed'
);

SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM navigation_permissions
     WHERE nav_section NOT IN ('leads', 'quo_monitor', 'cancellation_requests',
                               'payment_requests', 'quote_approval_requests',
                               'quote_pending_requests', 'analytics', 'settings',
                               'activity_logs', 'schedule', 'areas', 'map_view',
                               'technicians', 'quick_chat', 'tech_quick_chat')
  ),
  'no inert navigation_permissions rows remain'
);

-- -----------------------------------------------------------------------------
-- 4. Behaviour: anon
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;

DO $$
BEGIN
  BEGIN
    PERFORM public.can_create_manual_lead();
    RAISE NOTICE 'FAIL: anon could execute can_create_manual_lead()';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon is denied can_create_manual_lead()';
  END;

  BEGIN
    PERFORM public.delete_lead_by_admin('00000000-0000-4000-8000-0000000000ff');
    RAISE NOTICE 'FAIL: anon could execute delete_lead_by_admin()';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon is denied delete_lead_by_admin()';
  END;

  BEGIN
    PERFORM public.set_can_add_manual_leads('00000000-0000-4000-8000-0000000000ff', true);
    RAISE NOTICE 'FAIL: anon could execute set_can_add_manual_leads()';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon is denied set_can_add_manual_leads()';
  END;
END;
$$;

RESET ROLE;

-- -----------------------------------------------------------------------------
-- 5. Behaviour: authenticated, worst-case role-less identity
-- -----------------------------------------------------------------------------
-- Still postgres here (RESET ROLE above). Materialise the identity so the
-- profiles FK is satisfiable; handle_new_user() fills in the profiles row.
INSERT INTO auth.users (id, email)
  VALUES ('00000000-0000-4000-8000-0000000000ff', 'rls-gate-probe@example.invalid')
  ON CONFLICT (id) DO NOTHING;

-- Guard against handle_new_user() changing shape and silently leaving the
-- section 5 inserts to fail on the FK instead of on the policy under test.
SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000ff'),
  'synthetic role-less identity has a profiles row (leads.created_by FK is satisfiable)'
);

SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-0000000000ff', 'role', 'authenticated')::text,
  true);
SELECT set_config('request.jwt.claim.sub',  '00000000-0000-4000-8000-0000000000ff', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SET LOCAL ROLE authenticated;

-- 5a. the gate function itself
DO $$
DECLARE v boolean;
BEGIN
  v := public.can_create_manual_lead();
  IF v THEN
    RAISE NOTICE 'FAIL: role-less user passed can_create_manual_lead()';
  ELSE
    RAISE NOTICE 'PASS: role-less user is denied can_create_manual_lead()';
  END IF;
END;
$$;

-- 5b. extension path (manual_entry = false) must succeed
DO $$
BEGIN
  BEGIN
    INSERT INTO public.leads (job_id, customer_name, customer_phone, service_type,
                              created_by, manual_entry)
    VALUES ('LD-RLS-PROBE-' || gen_random_uuid()::text, 'RLS gate probe', '0000000000',
            'General', '00000000-0000-4000-8000-0000000000ff', false);
    RAISE NOTICE 'PASS: extension path (manual_entry=false) is allowed';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'FAIL: extension path (manual_entry=false) was rejected: %', SQLERRM;
  END;
END;
$$;

-- 5c. manual CRM path (manual_entry = true) must be denied
DO $$
BEGIN
  BEGIN
    INSERT INTO public.leads (job_id, customer_name, customer_phone, service_type,
                              created_by, manual_entry)
    VALUES ('LD-RLS-PROBE-' || gen_random_uuid()::text, 'RLS gate probe', '0000000000',
            'General', '00000000-0000-4000-8000-0000000000ff', true);
    RAISE NOTICE 'FAIL: manual_entry=true was allowed for a user without the grant';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: manual_entry=true denied for a user without the grant';
  WHEN OTHERS THEN
    RAISE NOTICE 'PASS: manual_entry=true denied for a user without the grant (%)', SQLERRM;
  END;
END;
$$;

-- 5d. a role-less caller must not be able to delete anyone else's lead
DO $$
BEGIN
  BEGIN
    PERFORM public.delete_lead_by_admin('00000000-0000-4000-8000-0000000000ff');
    RAISE NOTICE 'FAIL: role-less caller passed delete_lead_by_admin()';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS: role-less caller is denied by delete_lead_by_admin (%)', SQLERRM;
  END;
END;
$$;

-- 5e. a role-less caller must not be able to self-grant through the RPC
DO $$
BEGIN
  BEGIN
    PERFORM public.set_can_add_manual_leads('00000000-0000-4000-8000-0000000000ff', true);
    RAISE NOTICE 'FAIL: role-less caller passed set_can_add_manual_leads()';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS: role-less caller is denied by set_can_add_manual_leads (%)', SQLERRM;
  END;
END;
$$;

-- 5f. profiles self-grant must be blocked by the trigger
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles
       SET can_add_manual_leads = true
     WHERE id = '00000000-0000-4000-8000-0000000000ff';
    IF FOUND THEN
      RAISE NOTICE 'FAIL: profiles self-grant was allowed';
    ELSE
      RAISE NOTICE 'PASS: profiles self-grant had no target row (RLS denies the read)';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS: profiles self-grant is blocked (%)', SQLERRM;
  END;
END;
$$;

RESET ROLE;

-- -----------------------------------------------------------------------------
-- Summary (back as postgres)
-- -----------------------------------------------------------------------------
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, label
FROM _checks
ORDER BY ok, label;

SELECT count(*) FILTER (WHERE NOT ok) AS failures,
       count(*) FILTER (WHERE ok)     AS passes
FROM _checks;

ROLLBACK;
