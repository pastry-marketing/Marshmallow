-- =============================================================================
-- Migration : 20261023050000_rls_hardening.sql
-- Purpose   : Close the unauthenticated / anon write surface found in the
--             Phase A audit, and close two client-writable holes that were
--             never gated.
--
-- WHAT THIS DOES
--   1. Re-scopes the six `TO public` SELECT policies to `TO authenticated`.
--      Required BEFORE step 3: four of them call has_role(), so revoking anon
--      from has_role() first would make anon queries raise instead of return
--      empty. This preserves every USING expression byte-for-byte.
--   2. P0  delete_lead_by_admin(): its guard is
--            IF v_caller_role != 'admin' AND NOT (...) THEN RAISE
--          When auth.uid() IS NULL that whole expression evaluates to NULL,
--          the IF is not taken, and the function proceeds to DELETE a lead and
--          its notes/photos/shares/payments/notifications. It also has no
--          search_path. Fixed below + revoked from anon/PUBLIC. The rewrite also
--          switches to has_role(), which is EXISTS-based, so the guard stays
--          correct if a user holds more than one role.
--   3. Revokes anon (and PUBLIC) from every anon-EXECUTE function the app only
--      ever calls while authenticated. healthcheck() and
--      get_top_nearby_populated_areas() are deliberately left alone.
--   4. lead_payments INSERT: only required created_by = auth.uid(), so any
--      authenticated user could write payments against ANY lead id.
--   5. quo_conversation_flags INSERT/UPDATE: only required auth.uid() IS NOT
--      NULL, so any authenticated user could write flag rows for any
--      conversation. Both writers in this repo are edge functions running as
--      service_role (bypasses RLS), so tightening affects no live path.
--   6. Removes inert navigation_permissions rows for nav sections that are no
--      longer in ALL_NAV_ITEMS (`calls`, `map`).
--
-- NOT TOUCHED (deliberately): quo_conversations / quo_messages client policies.
-- Every client write to them is an intentional append from QuoChatDialog and
-- QuoDashboardPage; changing them needs its own review.
--
-- -----------------------------------------------------------------------------
-- ROLLBACK - run this block verbatim to undo everything below it.
-- -----------------------------------------------------------------------------
/*
DROP POLICY IF EXISTS "Lead payments require lead access" ON public.lead_payments;
CREATE POLICY "Authenticated can insert payments" ON public.lead_payments
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((created_by = ( SELECT auth.uid() AS uid)));

DROP POLICY IF EXISTS "Gated insert on quo_conversation_flags" ON public.quo_conversation_flags;
DROP POLICY IF EXISTS "Gated update on quo_conversation_flags" ON public.quo_conversation_flags;
CREATE POLICY "Allow authorized insert on quo_conversation_flags" ON public.quo_conversation_flags
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (( SELECT auth.uid() AS uid) IS NOT NULL);
CREATE POLICY "Allow authorized update on quo_conversation_flags" ON public.quo_conversation_flags
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (( SELECT auth.uid() AS uid) IS NOT NULL)
  WITH CHECK ((has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old)
        OR has_role(( SELECT auth.uid() AS uid), 'processor'::app_role_old)
        OR has_role(( SELECT auth.uid() AS uid), 'customer_service'::app_role_old)));

DROP POLICY IF EXISTS "Read calls scoped to owner admin or linked lead" ON public.calls;
DROP POLICY IF EXISTS "Read cancellation requests for accessible leads" ON public.lead_cancellation_requests;
DROP POLICY IF EXISTS "Read notes for accessible leads" ON public.lead_notes;
DROP POLICY IF EXISTS "Read shares for accessible leads" ON public.lead_shares;
DROP POLICY IF EXISTS "Read updates for accessible leads" ON public.lead_updates;
DROP POLICY IF EXISTS "Self or admin can view profile" ON public.profiles;

CREATE POLICY "Read calls scoped to owner admin or linked lead" ON public.calls
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((created_by = ( SELECT auth.uid() AS uid)) OR has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old) OR has_role(( SELECT auth.uid() AS uid), 'processor'::app_role_old) OR ((linked_lead_id IS NOT NULL) AND (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = calls.linked_lead_id)))));
CREATE POLICY "Read cancellation requests for accessible leads" ON public.lead_cancellation_requests
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old) OR has_role(( SELECT auth.uid() AS uid), 'processor'::app_role_old) OR (requested_by = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = lead_cancellation_requests.lead_id))));
CREATE POLICY "Read notes for accessible leads" ON public.lead_notes
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = lead_notes.lead_id)));
CREATE POLICY "Read shares for accessible leads" ON public.lead_shares
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((shared_with_user_id = ( SELECT auth.uid() AS uid)) OR (shared_by = ( SELECT auth.uid() AS uid)) OR has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old));
CREATE POLICY "Read updates for accessible leads" ON public.lead_updates
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = lead_updates.lead_id)));
CREATE POLICY "Self or admin can view profile" ON public.profiles
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((id = ( SELECT auth.uid() AS uid)) OR has_role(( SELECT auth.uid() AS uid), 'admin'::app_role));

GRANT EXECUTE ON FUNCTION public.assign_next_opr_code(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.current_user_opr_code() TO anon;
GRANT EXECUTE ON FUNCTION public.delete_lead_by_admin(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.dispatch_lead_status_notification(uuid,text,text,uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.get_opr_codes_summary() TO anon;
GRANT EXECUTE ON FUNCTION public.get_users_totp_status() TO anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid,app_role) TO anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid,app_role_old) TO anon;
GRANT EXECUTE ON FUNCTION public.is_assigned_opr_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.list_opr_codes() TO anon;
GRANT EXECUTE ON FUNCTION public.search_technicians(text,integer,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.set_lead_urgent_at() TO anon;
GRANT EXECUTE ON FUNCTION public.set_quote_requested_by() TO anon;
GRANT EXECUTE ON FUNCTION public.validate_technician_required_and_unique() TO anon;

CREATE OR REPLACE FUNCTION public.delete_lead_by_admin(target_lead_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_job_id text;
  v_caller_role text;
  v_is_cs_admin_mgr boolean;
BEGIN
  -- Get caller role
  SELECT role::text INTO v_caller_role FROM public.user_roles WHERE user_id = auth.uid();
  SELECT can_manage_users INTO v_is_cs_admin_mgr FROM public.profiles WHERE id = auth.uid();

  IF v_caller_role != 'admin' AND NOT (v_caller_role = 'cs_admin' AND v_is_cs_admin_mgr = true) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Get job_id for return
  SELECT job_id INTO v_job_id FROM public.leads WHERE id = target_lead_id;

  -- Delete from dependent tables
  DELETE FROM public.lead_notes WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_photos WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_shares WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_updates WHERE lead_id = target_lead_id;
  DELETE FROM public.notifications WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_payments WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_cancellation_requests WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_operator_assignments WHERE lead_id = target_lead_id;

  -- Finally, delete the lead
  DELETE FROM public.leads WHERE id = target_lead_id;

  RETURN json_build_object('success', true, 'job_id', v_job_id);
END;
$function$;
*/
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1 : TO public -> TO authenticated, USING expressions verbatim
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Read calls scoped to owner admin or linked lead" ON public.calls;
CREATE POLICY "Read calls scoped to owner admin or linked lead" ON public.calls
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((created_by = ( SELECT auth.uid() AS uid)) OR has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old) OR has_role(( SELECT auth.uid() AS uid), 'processor'::app_role_old) OR ((linked_lead_id IS NOT NULL) AND (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = calls.linked_lead_id)))));

DROP POLICY IF EXISTS "Read cancellation requests for accessible leads" ON public.lead_cancellation_requests;
CREATE POLICY "Read cancellation requests for accessible leads" ON public.lead_cancellation_requests
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old) OR has_role(( SELECT auth.uid() AS uid), 'processor'::app_role_old) OR (requested_by = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = lead_cancellation_requests.lead_id))));

DROP POLICY IF EXISTS "Read notes for accessible leads" ON public.lead_notes;
CREATE POLICY "Read notes for accessible leads" ON public.lead_notes
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = lead_notes.lead_id)));

DROP POLICY IF EXISTS "Read shares for accessible leads" ON public.lead_shares;
CREATE POLICY "Read shares for accessible leads" ON public.lead_shares
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((shared_with_user_id = ( SELECT auth.uid() AS uid)) OR (shared_by = ( SELECT auth.uid() AS uid)) OR has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old));

DROP POLICY IF EXISTS "Read updates for accessible leads" ON public.lead_updates;
CREATE POLICY "Read updates for accessible leads" ON public.lead_updates
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM leads WHERE (leads.id = lead_updates.lead_id)));

DROP POLICY IF EXISTS "Self or admin can view profile" ON public.profiles;
CREATE POLICY "Self or admin can view profile" ON public.profiles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((id = ( SELECT auth.uid() AS uid)) OR has_role(( SELECT auth.uid() AS uid), 'admin'::app_role));


-- -----------------------------------------------------------------------------
-- 2 : P0 - unauthenticated lead deletion + missing search_path
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_lead_by_admin(target_lead_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_job_id text;
  v_caller uuid := auth.uid();
  v_is_cs_admin_mgr boolean;
BEGIN
  SELECT can_manage_users INTO v_is_cs_admin_mgr FROM public.profiles WHERE id = v_caller;

  -- NULL-safe AND multi-role-safe. The legacy guard compared a role text value
  -- that was NULL when auth.uid() was NULL, so the whole IF evaluated to NULL
  -- (not true), the RAISE was skipped, and an anonymous caller could delete any
  -- lead plus all of its dependent rows. has_role() is EXISTS-based, so it is
  -- also correct if a user holds more than one role.
  IF v_caller IS NULL
     OR NOT (
       public.has_role(v_caller, 'admin'::public.app_role)
       OR (public.has_role(v_caller, 'cs_admin'::public.app_role) AND v_is_cs_admin_mgr = true)
     ) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Get job_id for return
  SELECT job_id INTO v_job_id FROM public.leads WHERE id = target_lead_id;

  -- Delete from dependent tables
  DELETE FROM public.lead_notes WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_photos WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_shares WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_updates WHERE lead_id = target_lead_id;
  DELETE FROM public.notifications WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_payments WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_cancellation_requests WHERE lead_id = target_lead_id;
  DELETE FROM public.lead_operator_assignments WHERE lead_id = target_lead_id;

  -- Finally, delete the lead
  DELETE FROM public.leads WHERE id = target_lead_id;

  RETURN json_build_object('success', true, 'job_id', v_job_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.delete_lead_by_admin(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_lead_by_admin(uuid) FROM anon;


-- -----------------------------------------------------------------------------
-- 3 : drop anon from every anon-EXECUTE function the app only calls when
--     logged in (all 11 .rpc() call sites in src/ sit behind ProtectedRoutes).
--     healthcheck() and get_top_nearby_populated_areas() are left granted.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.assign_next_opr_code(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_user_opr_code() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.dispatch_lead_status_notification(uuid,text,text,uuid[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_opr_codes_summary() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_users_totp_status() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid,app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid,app_role_old) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_assigned_opr_code(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_opr_codes() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.search_technicians(text,integer,integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_lead_urgent_at() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_quote_requested_by() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.validate_technician_required_and_unique() FROM PUBLIC, anon;

-- grant execution on functions that did not explicitly carry it for these roles
GRANT EXECUTE ON FUNCTION public.has_role(uuid,app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid,app_role_old) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_lead_by_admin(uuid) TO authenticated;


-- -----------------------------------------------------------------------------
-- 4 : lead_payments INSERT must target a lead the caller can already see
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated can insert payments" ON public.lead_payments;
DROP POLICY IF EXISTS "Lead payments require lead access" ON public.lead_payments;

CREATE POLICY "Lead payments require lead access" ON public.lead_payments
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    created_by = ( SELECT auth.uid() AS uid)
    AND EXISTS ( SELECT 1 FROM public.leads l WHERE l.id = lead_payments.lead_id )
  );


-- -----------------------------------------------------------------------------
-- 5 : quo_conversation_flags INSERT/UPDATE must be a Quo AI operator
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow authorized insert on quo_conversation_flags" ON public.quo_conversation_flags;
DROP POLICY IF EXISTS "Allow authorized update on quo_conversation_flags" ON public.quo_conversation_flags;
DROP POLICY IF EXISTS "Gated insert on quo_conversation_flags" ON public.quo_conversation_flags;
DROP POLICY IF EXISTS "Gated update on quo_conversation_flags" ON public.quo_conversation_flags;

CREATE POLICY "Gated insert on quo_conversation_flags" ON public.quo_conversation_flags
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (can_access_quo_ai());

CREATE POLICY "Gated update on quo_conversation_flags" ON public.quo_conversation_flags
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (can_access_quo_ai())
  WITH CHECK ((has_role(( SELECT auth.uid() AS uid), 'admin'::app_role_old)
        OR has_role(( SELECT auth.uid() AS uid), 'processor'::app_role_old)
        OR has_role(( SELECT auth.uid() AS uid), 'customer_service'::app_role_old)));


-- -----------------------------------------------------------------------------
-- 6 : drop inert navigation rows for sections no longer in ALL_NAV_ITEMS
-- -----------------------------------------------------------------------------
DELETE FROM public.navigation_permissions
 WHERE nav_section NOT IN (
   'leads', 'quo_monitor', 'cancellation_requests', 'payment_requests',
   'quote_approval_requests', 'quote_pending_requests', 'analytics',
   'settings', 'activity_logs', 'schedule', 'areas', 'map_view',
   'technicians', 'quick_chat', 'tech_quick_chat'
 );
