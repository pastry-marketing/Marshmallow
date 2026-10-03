-- =============================================================================
-- Migration : 20261104003000_fix_verification_for_all_roles.sql
-- Purpose   : Make approve_urgent_verification actually write, for every role
--             the dialog is shown to.
--
-- -----------------------------------------------------------------------------
-- THE BUG
--
--   approve_urgent_verification opened with:
--
--     v_role := COALESCE((SELECT role::text FROM public.user_roles ...), '');
--     IF v_role <> 'customer_service' THEN
--       -- Anyone who can already bypass the gate does not need a verification.
--       RETURN;
--     END IF;
--
--   That was written when the dialog was shown to customer_service only, and the
--   reasoning was sound at the time: those three roles are exempt from the gate,
--   so they have no use for the RPC.
--
--   The dialog is now shown to admin and cs_admin as well, and it calls this same
--   function to apply the change. So for those roles the function returned
--   immediately and wrote nothing at all.
--
--   The failure was silent and compound. The dialog reported success, then
--   onProceed() set the status in local form state and invalidated the lead
--   query. The refetch returned the unchanged row from the database, and
--
--     useEffect(() => { if (lead) setForm(lead) }, [lead]);
--
--   overwrote the form with it. The status snapped back to what it had been. An
--   admin marking a lead urgent saw a success toast and no change at all, with
--   nothing in the console to suggest why.
--
--   It did not affect customer_service, whose path did write, which is why it
--   survived being exercised on that role.
--
-- -----------------------------------------------------------------------------
-- THE FIX
--
--   Drop the role short-circuit and authorise on access instead, the same way
--   approve_urgent_acknowledgement already does. That function was written later,
--   after the dialog gained its unavailable branch, and it correctly accepts
--   admin, cs_admin, processor and the lead's own customer_service user. Two
--   functions that do the same job should not disagree about who they accept.
--
--   The access test is unchanged in substance: a reviewer role, or the customer
--   service user who created or is assigned the lead. That still stops anyone
--   minting a verification for a lead they cannot see.
--
-- -----------------------------------------------------------------------------
-- PROCESSOR IS NOT PART OF THIS
--
--   The dialog is not shown to processor, so nothing here changes for them. They
--   set urgent directly and the trigger still exempts them, which is what lets
--   dispatch move at their speed. The trigger's bypass list is unchanged by this
--   migration and must stay as it is: it is the enforcement backstop, and if it
--   started blocking these roles a dispatch workflow could jam on urgent work.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


CREATE OR REPLACE FUNCTION public.approve_urgent_verification(
  p_lead_id   uuid,
  p_ai_summary text DEFAULT NULL,
  p_ai_model   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  -- Authorise on access, not on role. The previous version returned early for
  -- anyone who was not customer_service, on the assumption that only they would
  -- ever call it.
  --
  -- This is deliberately the same test approve_urgent_acknowledgement uses, so
  -- the two paths cannot drift apart again.
  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'cs_admin'::app_role)
    OR public.has_role(v_uid, 'processor'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.id = p_lead_id
         AND (l.created_by = v_uid OR l.assigned_cs = v_uid)
    )
  ) THEN
    RAISE EXCEPTION 'You cannot verify a lead you do not have access to'
      USING ERRCODE = '42501';
  END IF;

  v_name := COALESCE((SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service');

  -- Row lock first, so the flag cannot outlive a concurrent review.
  PERFORM 1 FROM public.leads WHERE id = p_lead_id FOR UPDATE;

  PERFORM set_config('app.urgent_verified', 'on', true);
  UPDATE public.leads
     SET status              = 'urgent_job',
         last_edited_by      = v_uid,
         last_edited_by_name = v_name,
         last_edited_at      = now(),
         updated_at          = now()
   WHERE id = p_lead_id
     AND status IS DISTINCT FROM 'urgent_job';
  PERFORM set_config('app.urgent_verified', 'off', true);

  -- Settle anything the CS Admin queue still has open for this lead, in the same
  -- transaction as the status change, so there is no window where the lead is
  -- urgent and a request is still pending. Added in 20261104002000; repeated
  -- here because this function body is replaced wholesale.
  UPDATE public.lead_urgent_review_requests
     SET status     = 'approved',
         reviewed_at = now(),
         review_note = left(coalesce(review_note, '')
                           || ' Settled automatically: the conversation was corrected and re-checked, and it came back clean.',
                           500),
         updated_at  = now()
   WHERE lead_id = p_lead_id
     AND status = 'pending';

  INSERT INTO public.activity_logs (
    user_id, user_name, action, target_type, target_id, details
  )
  VALUES (
    v_uid,
    v_name,
    'urgent_verified',
    'lead',
    p_lead_id,
    jsonb_build_object(
      'ai_summary', coalesce(p_ai_summary, 'All verification checks passed'),
      'ai_model',   p_ai_model
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Never leave the flag set, whatever happened above it.
  PERFORM set_config('app.urgent_verified', 'off', true);
  RAISE;
END;
$fn$;

COMMENT ON FUNCTION public.approve_urgent_verification(uuid, text, text) IS
  'Applies urgent_job after an AI check found nothing, and settles any pending '
  'review request for that lead in the same transaction. Accepts admin, cs_admin, '
  'processor and the lead''s own customer_service user. It previously returned '
  'early for anyone who was not customer_service, so the advisory dialog appeared '
  'to work for admin and cs_admin while writing nothing.';


-- -----------------------------------------------------------------------------
-- Privileges and search path
--     ALTER FUNCTION ... SET, never RESET ALL. RESET ALL clears the pinned
--     search_path, which is how the earlier migrations ended up with SECURITY
--     DEFINER functions and no path pinned.
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.approve_urgent_verification(uuid, text, text)
  SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.approve_urgent_verification(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_urgent_verification(uuid, text, text) TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   Restores the early return for non customer_service callers, and with it the
--   silent no-op for admin and cs_admin. Reverting is only sensible for
--   diagnosis.
--
--   ALTER FUNCTION public.approve_urgent_verification(uuid, text, text)
--     RESET search_path;
--   REVOKE ALL ON FUNCTION public.approve_urgent_verification(uuid, text, text)
--     FROM PUBLIC, anon;
--   GRANT EXECUTE ON FUNCTION public.approve_urgent_verification(uuid, text, text)
--     TO authenticated;
--   -- then re-apply the 20261104000000 and 20261104002000 bodies.
-- =============================================================================