-- =============================================================================
-- Manual test harness: paid status rules
--
-- HOW TO RUN
--   Apply 20261030020000_enforce_paid_status_rules.sql first, then paste this
--   whole file into the Supabase SQL Editor and run it as `postgres`.
--   Nothing persists: the file opens a transaction and ROLLBACKs at the end.
--
-- WHAT IT PROVES
--   Rule 1  A lead that is already paid cannot change status - for anyone.
--   Rule 2  Only an Admin (or service_role) can move a lead INTO paid.
--   ...and, just as importantly, that the two real approval paths still work.
--
--   Leave the ROLLBACK in place. The success cases really do set a lead to paid.
--
-- Identities used (real accounts):
--   Admin      1abba3c0-b2e4-4194-9046-3ffd147e0ed0  kashif@accountboosters.com
--   Processor  eb18f72a-92f5-405b-83ac-a9192cca1d78  IrfanSC@gmail.com
--
-- Note: the results table is created as `authenticated` rather than granted to
-- it, because GRANT ... ON SCHEMA pg_temp fails with 3F000.
-- =============================================================================

BEGIN;

-- Sanity: we need both kinds of fixture to test anything.
DO $$
DECLARE v_open uuid; v_paid uuid;
BEGIN
  SELECT id INTO v_open FROM public.leads
   WHERE status IS DISTINCT FROM 'paid' AND status IS NOT NULL
   ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO v_paid FROM public.leads
   WHERE status = 'paid' ORDER BY created_at DESC LIMIT 1;
  RAISE NOTICE 'non-paid fixture: %   paid fixture: %', v_open, v_paid;
  IF v_open IS NULL OR v_paid IS NULL THEN
    RAISE EXCEPTION 'Need at least one non-paid lead and one paid lead to run this';
  END IF;
END $$;


-- ===========================================================================
-- 1. Processor must NOT be able to mark a lead paid   (rule 2 - must BLOCK)
-- ===========================================================================
SELECT set_config('request.jwt.claims', json_build_object(
  'sub','eb18f72a-92f5-405b-83ac-a9192cca1d78','role','authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub',  'eb18f72a-92f5-405b-83ac-a9192cca1d78', true);
SET LOCAL ROLE authenticated;

CREATE TEMP TABLE _paid_checks (id text, ok boolean NOT NULL, detail text) ON COMMIT DROP;

DO $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM public.leads
   WHERE status IS DISTINCT FROM 'paid' AND status IS NOT NULL
   ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE public.leads SET status = 'paid' WHERE id = v;
    INSERT INTO _paid_checks VALUES ('1 processor blocked from setting paid', false,
      'ALLOWED but should have been denied - trigger is not firing');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _paid_checks VALUES ('1 processor blocked from setting paid', true, SQLERRM);
  END;
END $$;

RESET ROLE;


-- ===========================================================================
-- 2. Admin approval must still WORK                  (rule 2 - must ALLOW)
--    The real path: an Admin approves a Paid Request.
-- ===========================================================================
SELECT set_config('request.jwt.claims', json_build_object(
  'sub','1abba3c0-b2e4-4194-9046-3ffd147e0ed0','role','authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub',  '1abba3c0-b2e4-4194-9046-3ffd147e0ed0', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM public.leads
   WHERE status IS DISTINCT FROM 'paid' AND status IS NOT NULL
   ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE public.leads SET status = 'paid' WHERE id = v;
    INSERT INTO _paid_checks VALUES ('2 admin CAN mark paid', true, 'allowed, as required');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _paid_checks VALUES ('2 admin CAN mark paid', false,
      'BLOCKED but must be allowed - this would break Paid Approval: ' || SQLERRM);
  END;
END $$;


-- ===========================================================================
-- 3. A paid lead is frozen                       (rule 1 - must BLOCK, Admin too)
-- ===========================================================================
DO $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM public.leads WHERE status = 'paid'
   ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE public.leads SET status = 'job_done' WHERE id = v;
    INSERT INTO _paid_checks VALUES ('3 paid lead cannot change status', false,
      'ALLOWED but should have been denied - paid is not locked');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _paid_checks VALUES ('3 paid lead cannot change status', true, SQLERRM);
  END;
END $$;


-- ===========================================================================
-- 4. Other columns on a paid lead must still be editable
--    Guards against the trigger being too broad and freezing the whole row.
-- ===========================================================================
DO $$
DECLARE v uuid; v_before numeric;
BEGIN
  SELECT id INTO v FROM public.leads WHERE status = 'paid'
   ORDER BY created_at DESC LIMIT 1;
  SELECT payment_amount INTO v_before FROM public.leads WHERE id = v;
  BEGIN
    UPDATE public.leads
       SET payment_amount = COALESCE(payment_amount, 0) + 1, updated_at = now()
     WHERE id = v;
    INSERT INTO _paid_checks VALUES ('4 other columns on a paid lead still editable', true,
      'allowed (payment_amount was ' || COALESCE(v_before::text,'null') || ')');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _paid_checks VALUES ('4 other columns on a paid lead still editable', false,
      'BLOCKED but must be allowed - trigger is too broad: ' || SQLERRM);
  END;
END $$;


-- ===========================================================================
-- 5. Re-saving an already-paid lead is a no-op, not an error
--    The lead paid in step 2 is now paid, so setting it to paid again is the
--    idempotent re-save an approval screen can trigger.
-- ===========================================================================
DO $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM public.leads WHERE status = 'paid'
   ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE public.leads SET status = 'paid' WHERE id = v;
    INSERT INTO _paid_checks VALUES ('5 re-saving an already paid lead is a no-op', true,
      'allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _paid_checks VALUES ('5 re-saving an already paid lead is a no-op', false,
      'BLOCKED but must be allowed: ' || SQLERRM);
  END;
END $$;

RESET ROLE;


-- ===========================================================================
-- 6. An ordinary status change is completely unaffected
--    Picks a lead that is still not paid, since steps 1-5 moved a couple.
-- ===========================================================================
SELECT set_config('request.jwt.claims', json_build_object(
  'sub','eb18f72a-92f5-405b-83ac-a9192cca1d78','role','authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub',  'eb18f72a-92f5-405b-83ac-a9192cca1d78', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM public.leads
   WHERE status IS DISTINCT FROM 'paid' AND status IS NOT NULL
   ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE public.leads SET status = 'job_done' WHERE id = v;
    INSERT INTO _paid_checks VALUES ('6 ordinary status change unaffected', true, 'allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _paid_checks VALUES ('6 ordinary status change unaffected', false,
      'BLOCKED but must be allowed: ' || SQLERRM);
  END;
END $$;

RESET ROLE;


-- ===========================================================================
-- RESULTS
-- ===========================================================================
SELECT id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
  FROM _paid_checks ORDER BY id;

SELECT count(*) FILTER (WHERE NOT ok) AS failures,
       count(*) FILTER (WHERE ok)     AS passes
  FROM _paid_checks;

ROLLBACK;
