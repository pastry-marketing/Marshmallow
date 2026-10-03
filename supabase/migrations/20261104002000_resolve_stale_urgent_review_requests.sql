-- =============================================================================
-- Migration : 20261104002000_resolve_stale_urgent_review_requests.sql
-- Purpose   : Stop the verification path from leaving an orphaned request in the
--             CS Admin queue.
--
-- -----------------------------------------------------------------------------
-- THE SEQUENCE
--
--   1. A customer_service member marks a lead urgent. The check finds a genuine
--      disagreement, so request_urgent_review() raises a pending request and the
--      lead stays where it is.
--   2. They fix the field the AI flagged and run the check again. It comes back
--      clean.
--   3. approve_urgent_verification() sets the lead to urgent_job.
--
--   The pending request from step 1 is still there. Nothing in the verification
--   path touched lead_urgent_review_requests.
--
-- WHY THAT MATTERS
--
--   A CS Admin opens a queue entry for a lead that is already urgent. Clicking
--   Approve is harmless, because review_urgent_request() notices the lead is
--   already urgent and skips the status write. Clicking Decline is not: the
--   request is marked declined, the lead stays urgent, and the activity trail now
--   records a CS Admin declining an urgent request that is in fact urgent.
--
--   That is the worst outcome available here, because it is wrong in the record
--   rather than in the data. Someone reading the trail later concludes the
--   escalation was refused when it was in fact satisfied.
--
--   The sidebar badge also counts the row, so the queue never clears and a
--   settled item keeps looking like work outstanding.
--
--   The one-pending-per-lead index is what makes this reachable rather than
--   merely possible: re-running the check after a fix updates the same row
--   rather than adding another, so the stale entry is the original one and
--   carries the original findings rather than the corrected state.
--
-- -----------------------------------------------------------------------------
-- THE FIX
--
--   Both apply paths now settle any pending request for that lead in the same
--   transaction that marks the lead urgent. There is no window in which the lead
--   is urgent and a request is still open.
--
--   The request is closed as approved, not deleted. Deleting would erase the
--   record that a review was ever needed, and that a CS member thought the
--   conversation disagreed before fixing it. That history is worth keeping.
--
--   The note says what actually happened, because "approved" alone would imply a
--   person looked at it. The reviewer's name is left null for the same reason: no
--   human reviewed this one, and attributing it to whoever happened to apply the
--   verification would put a false name against a real decision.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Settle the queue when a check comes back clean
-- -----------------------------------------------------------------------------
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
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  v_role := COALESCE(
    (SELECT role::text FROM public.user_roles WHERE user_id = v_uid ORDER BY role LIMIT 1),
    ''
  );

  IF v_role <> 'customer_service' THEN
    -- Anyone who can already bypass the gate does not need a verification.
    RETURN;
  END IF;

  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.id = p_lead_id
         AND (l.created_by = v_uid OR l.assigned_cs = v_uid)
    )
  ) THEN
    RAISE EXCEPTION 'You cannot verify a lead you do not have access to'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.leads WHERE id = p_lead_id FOR UPDATE;

  PERFORM set_config('app.urgent_verified', 'on', true);
  UPDATE public.leads
     SET status = 'urgent_job',
         last_edited_by      = v_uid,
         last_edited_by_name = COALESCE(
           (SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service'),
         last_edited_at = now(),
         updated_at     = now()
   WHERE id = p_lead_id
     AND status IS DISTINCT FROM 'urgent_job';
  PERFORM set_config('app.urgent_verified', 'off', true);

  -- Close out anything the CS Admin queue still has open for this lead, in the
  -- same transaction as the status change above. Without this the queue keeps a
  -- settled lead looking outstanding, and a reviewer who declines it produces a
  -- decline against a lead that is urgent regardless.
  UPDATE public.lead_urgent_review_requests
     SET status          = 'approved',
         reviewed_at      = now(),
         review_note      = left(coalesce(review_note, '')
                             || ' Settled automatically: the conversation was corrected and re-checked, and it came back clean.',
                             500),
         updated_at       = now()
   WHERE lead_id = p_lead_id
     AND status = 'pending';

  INSERT INTO public.activity_logs (
    user_id, user_name, action, target_type, target_id, details
  )
  VALUES (
    v_uid,
    COALESCE((SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service'),
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
  'Applies urgent_job for a customer_service user whose AI check found nothing, '
  'and settles any pending review request for that lead in the same transaction. '
  'The request is closed as approved with no reviewer name, because no human '
  'reviewed it.';


-- -----------------------------------------------------------------------------
-- 2. And the same for the acknowledgement path
--    A lead marked urgent unchecked may also have an earlier request open, from a
--    first attempt whose check found something.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_urgent_acknowledgement(
  p_lead_id uuid,
  p_reason  text DEFAULT NULL
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
    RAISE EXCEPTION 'You cannot approve a lead you do not have access to'
      USING ERRCODE = '42501';
  END IF;

  v_name := COALESCE((SELECT full_name FROM public.profiles WHERE id = v_uid), 'Customer Service');

  PERFORM set_config('app.urgent_verified', 'on', true);
  UPDATE public.leads
     SET status              = 'urgent_job',
         last_edited_by      = v_uid,
         last_edited_by_name = v_name,
         last_edited_at      = now(),
         updated_at          = now()
   WHERE id = p_lead_id;
  PERFORM set_config('app.urgent_verified', 'off', true);

  UPDATE public.lead_urgent_review_requests
     SET status     = 'approved',
         reviewed_at = now(),
         review_note = left(coalesce(review_note, '')
                           || ' Settled automatically: marked urgent without a check, by decision.',
                           500),
         updated_at  = now()
   WHERE lead_id = p_lead_id
     AND status = 'pending';

  INSERT INTO public.activity_logs (
    user_id, user_name, action, target_type, target_id, details
  )
  VALUES (
    v_uid, v_name, 'urgent_unverified_acknowledged', 'lead', p_lead_id,
    jsonb_build_object(
      'verified', false,
      'reason',   left(coalesce(p_reason, 'No conversation available to check'), 300)
    )
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.urgent_verified', 'off', true);
  RAISE;
END;
$fn$;

COMMENT ON FUNCTION public.approve_urgent_acknowledgement(uuid, text) IS
  'Applies urgent_job after a person explicitly accepted that no verification '
  'was possible, and settles any pending review request for that lead. Logs an '
  'acknowledgement, never a passed check.';


-- -----------------------------------------------------------------------------
-- 3. Privileges and search path
--    ALTER FUNCTION ... SET, never RESET ALL. RESET ALL clears the pinned
--    search_path, which is how the previous migration ended up with six SECURITY
--    DEFINER functions and no path pinned. See 20261104001000.
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.approve_urgent_verification(uuid, text, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_urgent_acknowledgement(uuid, text)
  SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.approve_urgent_verification(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_urgent_acknowledgement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_urgent_verification(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_urgent_acknowledgement(uuid, text) TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   The two functions revert to their previous bodies, which is to say the stale
--   request behaviour comes back. Nothing in the database is modified by this
--   migration, so there is no data to restore.
--
--   To see the effect of the fix without running it, note that this migration
--   changes no table and touches no lead row. Reverting is a matter of
--   re-applying the 20261104000000 versions of both functions.
-- =============================================================================