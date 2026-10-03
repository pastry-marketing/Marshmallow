-- =============================================================================
-- Migration : 20261104001000_urgent_gate_security_fix.sql
-- Purpose   : Repair two defects left by 20261104000000_urgent_review_gate.sql.
--
-- -----------------------------------------------------------------------------
-- DEFECT 1  THE VERIFICATION FLAG WAS THE ONLY THING BLOCKING A DATA LEAK
--
--   20261104000000 granted EXECUTE using this pattern:
--
--     ALTER FUNCTION public.list_urgent_review_requests(text) RESET ALL;
--     GRANT EXECUTE ON FUNCTION public.list_urgent_review_requests(text)
--       TO authenticated;
--
--   The intent was to clear a stale world grant. It does not do that.
--
--   ALTER FUNCTION ... RESET ALL resets function *configuration*. It does not
--   touch privileges at all. Confirmed on the live database after 20261104000000
--   was applied: proacl came back as
--
--     {=X/postgres,postgres=X/postgres,anon=X/postgres,
--      authenticated=X/postgres,service_role=X/postgres}
--
--   The leading "=X" is PUBLIC. So the world grant survived, and anon had an
--   explicit grant as well.
--
--   list_urgent_review_requests is SECURITY DEFINER and contained no check on
--   the caller. The function owner has rolbypassrls, so RLS did not stop it
--   either. Result: anyone holding only the public anon key could call it and
--   read every urgent review request in the database, including customer names,
--   job ids, the AI's findings and who reviewed them.
--
--   The other five functions were not exploitable this way, because each one
--   raises when auth.uid() is null. This one had no such check, which is the
--   only reason it was the leak.
--
--   Two things are fixed, not one. The grants are corrected with REVOKE, and the
--   function grows an internal authorisation check. The second is the one that
--   holds: a function that verifies its own caller cannot be reopened by a
--   future GRANT slip, and SECURITY DEFINER without an internal check is a
--   loaded weapon regardless of who currently holds the grant.
--
-- -----------------------------------------------------------------------------
-- DEFECT 2  RESET ALL ALSO ERASED THE PINNED search_path
--
--   Every function was declared with
--
--     SET search_path = public, pg_temp
--
--   and then had ALTER FUNCTION ... RESET ALL applied afterwards, which cleared
--   proconfig back to null. Verified on the live database: proconfig is null for
--   all six, so none of them had a pinned search_path.
--
--   That matters because these are SECURITY DEFINER functions. Without a pinned
--   path, a caller who can create an object in a schema that sorts ahead of
--   public can shadow a table or function inside a definer context and run
--   code as the owner. It is the same class of bug the pinning was added to
--   prevent, introduced by the command meant to help.
--
--   RESET ALL is the wrong tool for both jobs. Configuration is set with
--   ALTER FUNCTION ... SET, privileges with REVOKE and GRANT.
--
-- -----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT CHANGED
--
--   No lead row is touched. No status changes. No schedule is written.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Re-pin the search path
--    ALTER FUNCTION ... SET, not RESET. This is the inverse of what went wrong.
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.enforce_urgent_gate()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_urgent_verification(uuid, text, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_urgent_acknowledgement(uuid, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.review_urgent_request(uuid, boolean, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.list_urgent_review_requests(text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.set_urgent_review_updated_at()
  SET search_path = public, pg_temp;


-- -----------------------------------------------------------------------------
-- 2. Rebuild the list function with an internal authorisation check
--
--    Same name, same argument, same return shape, so the frontend and the
--    sidebar badge need no change. LANGUAGE sql becomes plpgsql because a guard
--    that raises cannot be expressed in a SQL function body.
--
--    Visible to the requester and to reviewers only, which is what the SELECT
--    policy already allows. Repeating it here means the function is safe on its
--    own terms even if it is ever granted more widely by mistake.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_urgent_review_requests(text);

CREATE FUNCTION public.list_urgent_review_requests(
  p_status text DEFAULT 'pending'
)
RETURNS TABLE (
  id                 uuid,
  lead_id            uuid,
  previous_status    text,
  lead_job_id        text,
  lead_customer_name text,
  requested_by       uuid,
  requested_by_name  text,
  ai_issues          jsonb,
  ai_summary         text,
  ai_model           text,
  status             text,
  reviewed_by_name   text,
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz,
  current_status     text,
  current_service_details  text,
  current_customer_schedule_requirements text,
  current_quote      text,
  current_terms      text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  -- Mirrors the SELECT policy on the table. Kept here as well so the function is
  -- not readable by anyone who is neither a reviewer nor the requester, whatever
  -- the grants say.
  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'cs_admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.lead_urgent_review_requests r
       WHERE r.requested_by = v_uid
    )
  ) THEN
    RAISE EXCEPTION 'You do not have access to the urgent review queue'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT r.id, r.lead_id, r.previous_status, r.lead_job_id, r.lead_customer_name,
           r.requested_by, r.requested_by_name, r.ai_issues, r.ai_summary,
           r.ai_model, r.status, r.reviewed_by_name, r.reviewed_at, r.review_note,
           r.created_at,
           l.status, l.service_details, l.customer_schedule_requirements,
           l.quote, l.terms
      FROM public.lead_urgent_review_requests r
      LEFT JOIN public.leads l ON l.id = r.lead_id
     WHERE r.status = COALESCE(p_status, 'pending')
       AND (public.has_role(v_uid, 'admin'::app_role)
            OR public.has_role(v_uid, 'cs_admin'::app_role)
            OR r.requested_by = v_uid)
     ORDER BY r.created_at;
END;
$fn$;

COMMENT ON FUNCTION public.list_urgent_review_requests(text) IS
  'Urgent review queue for CS Admins, Admins, and the requester. Checks the '
  'caller internally rather than relying on its grant, because it is SECURITY '
  'DEFINER and the owner bypasses row level security.';


-- -----------------------------------------------------------------------------
-- 3. Correct the privileges, using the commands that actually govern them
--
--    PUBLIC first, because the world grant arrives as a PUBLIC entry rather
--    than as a role, and REVOKE ... FROM anon alone leaves it in place. anon is
--    revoked separately since it also holds an explicit grant here.
--
--    Trigger functions are revoked from authenticated as well. A trigger does
--    not need EXECUTE on its function to fire, so nobody needs to call
--    enforce_urgent_gate() or set_urgent_review_updated_at() by hand.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.enforce_urgent_gate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_urgent_review_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_urgent_verification(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_urgent_acknowledgement(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_urgent_request(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_urgent_review_requests(text) FROM PUBLIC, anon;

-- The four the application calls, plus the two trigger functions for admin use.
GRANT EXECUTE ON FUNCTION public.approve_urgent_verification(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_urgent_acknowledgement(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_urgent_request(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_urgent_review_requests(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_urgent_gate() TO service_role;
GRANT EXECUTE ON FUNCTION public.set_urgent_review_updated_at() TO service_role;


-- -----------------------------------------------------------------------------
-- 4. Table grants, stated explicitly
--    Verified already correct after 20261104000000 — anon holds nothing — but
--    written down so the next reader can see it was checked rather than assumed.
-- -----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.lead_urgent_review_requests FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lead_urgent_review_requests TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   Reverting does not restore the leak, and should not be done on a database
--   that is reachable. It exists only to document the previous state.
--
--   REVOKE ALL ON FUNCTION public.approve_urgent_verification(uuid, text, text)
--     FROM PUBLIC, anon;
--   REVOKE ALL ON FUNCTION public.approve_urgent_acknowledgement(uuid, text)
--     FROM PUBLIC, anon;
--   REVOKE ALL ON FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text)
--     FROM PUBLIC, anon;
--   REVOKE ALL ON FUNCTION public.review_urgent_request(uuid, boolean, text)
--     FROM PUBLIC, anon;
--   DROP FUNCTION IF EXISTS public.list_urgent_review_requests(text);
--   GRANT EXECUTE ON FUNCTION public.approve_urgent_verification(uuid, text, text)
--     TO PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.approve_urgent_acknowledgement(uuid, text)
--     TO PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.request_urgent_review(uuid, jsonb, text, text, text, text, text)
--     TO PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.review_urgent_request(uuid, boolean, text)
--     TO PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.list_urgent_review_requests(text)
--     TO PUBLIC, anon, authenticated;
--
-- The four grants above reopen the leak that step 3 closed.
-- =============================================================================