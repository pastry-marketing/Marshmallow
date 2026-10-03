-- =============================================================================
-- Migration : 20261104004000_temporarily_disable_urgent_gate.sql
-- Purpose   : TEMPORARY. Switch the urgent gate off so leads can be made
--             urgent again, while the AI verification path is sorted out.
--
-- WHY
--   enforce_urgent_gate() blocks customer_service from two things: creating a
--   lead already in urgent_job, and moving one into urgent_job without a
--   verified AI check. Urgent work cannot wait on that check, so until the
--   verification path is reliable the gate is doing more harm than good.
--
-- WHAT THIS DOES
--   Drops the trigger only. Everything else the feature added stays exactly as
--   it is: enforce_urgent_gate() itself, lead_urgent_review_requests, and the
--   approve/request/review functions. Nothing is dropped that holds data, and
--   no function body is rewritten, so there is nothing here to transcribe
--   wrongly on the way back.
--
--   With the trigger gone the database accepts urgent_job from any role that
--   row level security already lets write the lead, which is how it behaved
--   before 20261104000000_urgent_review_gate.sql.
--
--   The front end is switched off separately, by URGENT_CHECK_ENABLED in
--   src/lib/urgent-verification.ts. Both have to be on for the feature to be
--   on, and both are off now.
--
-- -----------------------------------------------------------------------------
-- TO RESTORE THE GATE - run this one statement:
-- -----------------------------------------------------------------------------
/*
CREATE TRIGGER leads_urgent_gate
  BEFORE INSERT OR UPDATE OF status ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_urgent_gate();
*/
-- and set URGENT_CHECK_ENABLED back to true in src/lib/urgent-verification.ts.
--
-- NOTE
--   supabase/tests/80_urgent_review_gate.sql asserts that the gate blocks. It
--   is run by hand, not in CI, and it is expected to fail while the gate is
--   off. It is left untouched so it still proves the gate when restored.
-- =============================================================================

DROP TRIGGER IF EXISTS leads_urgent_gate ON public.leads;

COMMENT ON FUNCTION public.enforce_urgent_gate() IS
  'TEMPORARILY NOT IN USE: its trigger was dropped by '
  '20261104004000_temporarily_disable_urgent_gate.sql so urgent leads can be '
  'created and set again. The body is unchanged; recreate the leads_urgent_gate '
  'trigger to put it back. Blocks customer_service from creating a lead as '
  'urgent_job, and from moving one into urgent_job without a verified AI check '
  'or a human review.';
