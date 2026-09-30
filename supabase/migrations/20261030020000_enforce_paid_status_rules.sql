-- =============================================================================
-- Migration : 20261030020000_enforce_paid_status_rules.sql
-- Purpose   : Close two gaps around the `paid` status at the database layer.
--
-- GAP 1 - Paid Approval could be bypassed
--   The Paid Approval workflow exists so an Admin reviews the amount and the
--   payment screenshot before a lead becomes paid. The leads UPDATE policy only
--   blocks non-admins from `scammed`, and no function in the schema references
--   `'paid'::text` at all, so nothing stopped a Processor - or a CS who created
--   the lead, whose UPDATE policy allows created_by - from setting
--   status = 'paid' directly and skipping the approval entirely.
--
-- GAP 2 - `paid` was never actually locked
--   The documentation states that once a lead is paid, no role including Admin
--   can change its status again, and that this is "enforced by the trigger, not
--   by UI alone". No such trigger existed. The only triggers on leads were
--   leads_enforce_tag_role_access, route_cs_quote_to_approval,
--   set_lead_user_snapshot_names, trg_set_lead_urgent_at and
--   trigger_set_quote_requested_by. With 368 paid and 17 partial_paid leads live,
--   any user who could update a lead could move a settled lead back to any
--   other status.
--
-- THE FIX
--   One BEFORE UPDATE trigger covering both rules. It fires alphabetically
--   first among the leads triggers, so it sees the requested status before any
--   other BEFORE trigger rewrites it.
--
--     Rule 1  A lead that is already paid may never change status. This holds
--             for every caller including Admin, which is what the documentation
--             describes. Editing other columns on a paid lead is unaffected -
--             only a status change is rejected.
--
--     Rule 2  Only an Admin may move a lead INTO paid. A null auth.uid() means
--             a trusted server-side caller (service_role, which bypasses RLS)
--             and is allowed, matching the convention used by
--             protect_profile_privilege_flags.
--
--   The legitimate paths are unaffected:
--     - Admin approves a Paid Request (payment-requests.ts) - auth.uid() is the
--       reviewing Admin, and the status moves payment_requested -> paid.
--     - Admin sets paid directly from the lead payment dialog - same caller.
--     - Any edge function running as service_role - auth.uid() is NULL.
--   A Processor submitting a Paid Request is unaffected, because that only moves
--   the lead to payment_requested; it is the approval that sets paid.
--
--   Note: the existing RLS clause already prevents cs_admin from setting paid
--   outright. Rule 2 is defence in depth for the roles RLS does not cover.
--
-- TEST BEFORE COMMITTING
--   Run the whole file inside a transaction you do not commit, and confirm the
--   two blocks are enforced and the two approvals are not. Then ROLLBACK and
--   re-run for real.
--
-- -----------------------------------------------------------------------------
-- ROLLBACK - run this block verbatim to undo everything below it.
-- -----------------------------------------------------------------------------
/*
DROP TRIGGER IF EXISTS enforce_paid_status_rules ON public.leads;
DROP FUNCTION IF EXISTS public.enforce_paid_status_rules();
*/
-- =============================================================================


CREATE OR REPLACE FUNCTION public.enforce_paid_status_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  -- Rule 1: paid is terminal, for everyone.
  IF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'A paid lead cannot change status (attempted % -> %). Paid is final.', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule 2: only an Admin, or a trusted server-side caller, may mark paid.
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    IF v_caller IS NULL THEN
      -- service_role: no JWT, runs with RLS bypassed by the platform.
      RETURN NEW;
    END IF;

    IF public.has_role(v_caller, 'admin'::public.app_role) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'Only an Admin can mark a lead paid. Submit a Paid Request and have it approved instead.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_paid_status_rules ON public.leads;

CREATE TRIGGER enforce_paid_status_rules
  BEFORE UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_paid_status_rules();
