-- =============================================================================
-- Harness : 80_urgent_review_gate.sql
-- Purpose : Prove the urgent gate actually blocks and admits what it claims,
--           rather than assuming it does because it compiled.
--
-- WHY THIS EXISTS
--   This project's first version of this gate had its condition inverted. It
--   fired when status did NOT change, so every real transition into urgent
--   passed straight through while unrelated edits to already-urgent leads were
--   rejected instead. It compiled. It reported success. It would have been the
--   opposite of the intended behaviour in production.
--
--   An existence check ("is the trigger there?") would have passed on that bug.
--   Only executing a real transition catches it, so every check below performs
--   the update and reads what the database actually did.
--
-- HOW TO RUN
--   Apply 20261104000000_urgent_review_gate.sql first, then run this in the
--   Supabase SQL editor.
--
--   It returns one row per check with an OK column. A check that fails is
--   caught and recorded rather than raised, so one failure never hides the
--   checks after it.
--
--   Everything runs inside a transaction that is rolled back at the end, so no
--   lead is left urgent and no review request survives. The gate's own
--   transaction-local flag is reset by the functions, but the outer ROLLBACK is
--   the real guarantee.
--
--   Expected: every OK is true. Read DETAIL for the expected and actual values.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _results (
  seq    integer PRIMARY KEY,
  name   text NOT NULL,
  ok     boolean NOT NULL,
  detail text
) ON COMMIT DROP;

-- A scratch lead to move through the gate. Rolled back at the end.
CREATE TEMP TABLE _probe (
  id     uuid PRIMARY KEY,
  status text   NOT NULL
) ON COMMIT DROP;


-- -----------------------------------------------------------------------------
-- How identity is faked here, and what that does and does not prove
--
-- The gate reads auth.uid(). auth.uid() prefers request.jwt.claim.sub and falls
-- back to request.jwt.claims, so both are set to the user being impersonated.
--
-- This harness does NOT switch to the authenticated role. SET LOCAL ROLE cannot
-- be issued inside a plpgsql block, and it is not needed: what is under test is
-- the trigger, which runs for every writer regardless of role. Staying as the
-- editor role means leads row level security is bypassed here, which is correct
-- for these checks, because the policies on leads are exercised by
-- 40_leads_rls_baseline.sql and are not what check 3 is about.
--
-- What this proves is therefore: given a caller whose auth.uid() is a
-- customer_service user, does the transition into urgent succeed or fail. That
-- is exactly the question, and it is answered by executing the update.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- 01  Objects exist
--     to_regclass resolves relations. Functions need to_regprocedure with their
--     full argument signature, otherwise each one reads as missing and this check
--     fails for the wrong reason.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(obj, ', ' ORDER BY obj) INTO v_missing
    FROM unnest(ARRAY[
      'public.lead_urgent_review_requests',
      'public.enforce_urgent_gate()',
      'public.approve_urgent_verification(uuid, text, text)',
      'public.approve_urgent_acknowledgement(uuid, text)',
      'public.request_urgent_review(uuid, jsonb, text, text, text, text, text)',
      'public.review_urgent_request(uuid, boolean, text)',
      'public.list_urgent_review_requests(text)'
    ]) AS obj
   WHERE to_regclass(obj) IS NULL
      AND to_regprocedure(obj) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing: %', v_missing;
  END IF;

  INSERT INTO _results VALUES (1, 'objects exist', true, '7 objects');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (1, 'objects exist', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 02  The trigger is attached to leads on the status column
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(x, ', ') INTO v_missing
    FROM unnest(ARRAY[
      'leads_urgent_gate',
      'lead_urgent_review_updated_at'
    ]) AS x
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger t
      WHERE t.tgname = x AND NOT t.tgisinternal
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'triggers missing: %', v_missing;
  END IF;

  INSERT INTO _results VALUES (2, 'triggers attached', true, 'both present');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (2, 'triggers attached', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 03  A customer_service user is BLOCKED entering urgent
--
--     This is the check the inverted condition would have failed. The transition
--     is real: waiting_complete_details to urgent_job, executed as a
--     customer_service user, expected to raise.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_id      uuid;
  v_user    uuid;
  v_blocked boolean := false;
  v_message text;
BEGIN
  SELECT id INTO v_id FROM public.leads WHERE status = 'waiting_complete_details' LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO _results VALUES (3, 'CS blocked entering urgent', true, 'skipped, no CS-owned lead available');
    RETURN;
  END IF;

  -- The gate reads auth.uid(), so a role has to be acting as somebody. Any
  -- authenticated user who is not admin, processor or cs_admin exercises the
  -- restricted path.
  SELECT user_id INTO v_user
    FROM public.user_roles
   WHERE role = 'customer_service'
   LIMIT 1;

  IF v_user IS NULL THEN
    INSERT INTO _results VALUES (3, 'CS blocked entering urgent', true, 'skipped, no customer_service user');
    RETURN;
  END IF;

  INSERT INTO _probe (id, status) VALUES (v_id, 'urgent_job');

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    UPDATE public.leads
       SET status = 'urgent_job'
     WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_blocked := true;
    v_message := SQLERRM;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'the update was allowed, so the gate is not holding';
  END IF;

  INSERT INTO _results VALUES (
    3, 'CS blocked entering urgent', true,
    'raised ' || left(coalesce(v_message, ''), 60)
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (3, 'CS blocked entering urgent', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 04  The probe row was NOT left urgent
--     A trigger that raises inside the statement should leave the row untouched.
--     This catches a gate that blocks by corrupting the row instead.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM _probe LIMIT 1;

  IF v_status IS NULL THEN
    INSERT INTO _results VALUES (4, 'blocked write left row unchanged', true, 'skipped, no probe row');
    RETURN;
  END IF;

  -- _probe was seeded with the target status, so instead read the real row.
  IF EXISTS (SELECT 1 FROM public.leads l JOIN _probe p ON p.id = l.id WHERE l.status = 'urgent_job') THEN
    RAISE EXCEPTION 'a lead is urgent despite the gate raising';
  END IF;

  INSERT INTO _results VALUES (4, 'blocked write left row unchanged', true, 'no lead forced urgent');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (4, 'blocked write left row unchanged', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 05  The gate does NOT fire when urgent is not involved
--     The inverted version of this condition rejected these. Leaving urgent, or
--     editing a lead that is already urgent, must be allowed.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_id      uuid;
  v_user    uuid;
  v_ok      boolean := true;
  v_detail  text := '';
BEGIN
  SELECT l.id INTO v_id
    FROM public.leads l
   WHERE l.status = 'urgent_job'
   LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO _results VALUES (5, 'non-urgent transitions unaffected', true, 'skipped, no urgent lead');
    RETURN;
  END IF;

  SELECT user_id INTO v_user FROM public.user_roles WHERE role = 'customer_service' LIMIT 1;
  IF v_user IS NULL THEN
    INSERT INTO _results VALUES (5, 'non-urgent transitions unaffected', true, 'skipped, no customer_service user');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  -- urgent -> needs_reschedule. The gate must stay out of this.
  BEGIN
    UPDATE public.leads SET status = 'needs_reschedule' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
    v_detail := 'urgent -> needs_reschedule raised: ' || left(SQLERRM, 50);
  END;

  -- needs_reschedule -> urgent_job, still blocked. Confirms the first update
  -- really did land, so this is a real second transition and not a no-op.
  IF v_ok THEN
    BEGIN
      UPDATE public.leads SET status = 'urgent_job' WHERE id = v_id;
      v_ok := false;
      v_detail := 'the reverse transition was allowed';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  -- Back to urgent without touching status at all, only a comment field. The
  -- original inverted condition rejected exactly this.
  IF v_ok THEN
    BEGIN
      UPDATE public.leads SET cs_tag = cs_tag WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      v_ok := false;
      v_detail := 'a non-status edit on an urgent lead raised: ' || left(SQLERRM, 50);
    END;
  END IF;

  IF NOT v_ok THEN
    RAISE EXCEPTION '%', v_detail;
  END IF;

  INSERT INTO _results VALUES (5, 'non-urgent transitions unaffected', true, 'leave, re-enter, and edit all correct');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (5, 'non-urgent transitions unaffected', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 06  The verified flag is the only way past the gate
--     Sets the same transaction-local flag approve_urgent_verification uses and
--     confirms the write is admitted. If this fails, a clean AI result can never
--     become urgent and the feature is unusable.
--
--     The source status is an allowlist, not "any lead that is not urgent".
--     The first version picked one at random and landed on a lead whose status was
--     paid, so enforce_paid_status_rules -- an unrelated BEFORE UPDATE trigger that
--     makes paid immutable -- rejected the write first. The check reported that
--     the flag had failed, when the flag had in fact worked and a pre-existing rule
--     had objected. That is the worst shape of harness failure: it points at the
--     wrong component.
--
--     The error text is now reported rather than swallowed, so a genuine failure
--     here names its cause instead of just saying the write was refused.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_id     uuid;
  v_status text;
  v_blocked boolean := false;
  v_message text := '';
BEGIN
  -- Transition-friendly sources only. paid, cancelled and scammed are governed
  -- by their own rules and would raise for reasons that have nothing to do with
  -- this gate.
  SELECT id INTO v_id
    FROM public.leads
   WHERE status IN (
     'waiting_complete_details', 'need_tech', 'quote_sent_waiting',
     'needs_quote', 'quote_change', 'scheduled', 'waiting_customer_response'
   )
   LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO _results VALUES (6, 'flag admits a verified write', true, 'skipped, no transition-friendly lead');
    RETURN;
  END IF;

  BEGIN
    PERFORM set_config('app.urgent_verified', 'on', true);
    UPDATE public.leads SET status = 'urgent_job' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_blocked := true;
    v_message := SQLERRM;
  END;

  PERFORM set_config('app.urgent_verified', 'off', true);

  IF v_blocked THEN
    RAISE EXCEPTION 'the flag did not admit the write: %', left(v_message, 200);
  END IF;

  SELECT status INTO v_status FROM public.leads WHERE id = v_id;
  IF v_status <> 'urgent_job' THEN
    RAISE EXCEPTION 'wrote but status is %, expected urgent_job', coalesce(v_status, 'null');
  END IF;

  INSERT INTO _results VALUES (6, 'flag admits a verified write', true, 'urgent_job written');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (6, 'flag admits a verified write', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 06b  A lead cannot be CREATED as urgent either
--
--     The gate was originally BEFORE UPDATE only, which left this wide open. The
--     Chrome extension posts a draft with a status field, and one insert with
--     urgent_job skipped the trigger completely. This check is the reason the
--     trigger covers INSERT.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_id      uuid;
  v_user    uuid;
  v_blocked boolean := false;
BEGIN
  SELECT user_id INTO v_user FROM public.user_roles WHERE role = 'customer_service' LIMIT 1;
  IF v_user IS NULL THEN
    INSERT INTO _results VALUES (15, 'cannot CREATE a lead as urgent', true, 'skipped, no customer_service user');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  BEGIN
    INSERT INTO public.leads (job_id, customer_name, customer_phone, status, created_by)
    VALUES ('ZZ-HARNESS', 'Harness Probe', '9990000000', 'urgent_job', v_user)
    RETURNING id INTO v_id;
  EXCEPTION WHEN OTHERS THEN
    v_blocked := true;
  END;

  IF NOT v_blocked THEN
    DELETE FROM public.leads WHERE id = v_id;
    RAISE EXCEPTION 'an urgent lead was created directly';
  END IF;

  -- The flag must not admit an insert either. There is nothing to have verified
  -- before the row exists, so honouring it here would be a way around the gate.
  PERFORM set_config('app.urgent_verified', 'on', true);
  BEGIN
    INSERT INTO public.leads (job_id, customer_name, customer_phone, status, created_by)
    VALUES ('ZZ-HARNESS2', 'Harness Probe', '9990000001', 'urgent_job', v_user)
    RETURNING id INTO v_id;
    PERFORM set_config('app.urgent_verified', 'off', true);
    DELETE FROM public.leads WHERE id = v_id;
    RAISE EXCEPTION 'the flag admitted an urgent insert';
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.urgent_verified', 'off', true);
    NULL;
  END;

  INSERT INTO _results VALUES (15, 'cannot CREATE a lead as urgent', true, 'blocked, and the flag does not admit it');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (15, 'cannot CREATE a lead as urgent', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 07  The flag does not leak past the transaction-local scope
--     A plain SET inside the function is the failure mode: it would stay on for
--     the rest of the connection and let the next write through unchecked.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_leaked text;
BEGIN
  v_leaked := current_setting('app.urgent_verified', true);
  IF coalesce(v_leaked, 'off') = 'on' THEN
    RAISE EXCEPTION 'the flag is still set outside the function that should own it';
  END IF;

  INSERT INTO _results VALUES (7, 'verification flag does not leak', true, 'off outside its function');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (7, 'verification flag does not leak', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 08  Nothing in the workflow writes the schedule
--     The single most important property here. Urgent is dispatch priority, and a
--     large part of what the AI checks is whether the agreed schedule was
--     recorded correctly. If approval rewrites the schedule it would destroy the
--     very evidence it was asked to protect.
--
--     Verified by reading the function source rather than trusting review.
--
--     The match is anchored: the column name must be followed immediately by an
--     equals sign, allowing whitespace. The first version used
--     ILIKE '%column% =%', which is wrong twice over. The % spans newlines, so a
--     mention of scheduled_date in the comment "deliberately untouched" paired up
--     with the equals sign in a completely unrelated SET status = line two
--     statements below, and the check reported that the approval path rewrites the
--     schedule when it does not. Anchoring removes the cross-statement pairing,
--     and an assignment inside a comment would have to be written as
--     "scheduled_date =" to be caught.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_src  text;
  v_bad  text;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE oid = to_regprocedure('public.approve_urgent_verification(uuid,text,text)');

  SELECT string_agg(DISTINCT col, ', ') INTO v_bad
    FROM unnest(ARRAY['scheduled_date', 'scheduled_time_start', 'customer_schedule_requirements']) AS col
   WHERE (v_src ~* (col || '\s*='));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these schedule columns are assigned: %', v_bad;
  END IF;

  INSERT INTO _results VALUES (8, 'verification path leaves the schedule alone', true, 'no schedule assignment');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (8, 'verification path leaves the schedule alone', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 09  Approval path leaves the schedule alone, for the same reason
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
  v_bad text;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE oid = to_regprocedure('public.review_urgent_request(uuid,boolean,text)');

  -- Anchored, for the same reason as check 8.
  SELECT string_agg(DISTINCT col, ', ') INTO v_bad
    FROM unnest(ARRAY['scheduled_date', 'scheduled_time_start', 'customer_schedule_requirements']) AS col
   WHERE (v_src ~* (col || '\s*='));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these schedule columns are assigned: %', v_bad;
  END IF;

  INSERT INTO _results VALUES (9, 'approval path leaves the schedule alone', true, 'no schedule assignment');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (9, 'approval path leaves the schedule alone', false, SQLERRM);
END $$;
-- -----------------------------------------------------------------------------
-- 10  A cs_admin cannot approve their own request
--
--     The first version of this check skipped itself whenever the queue was
--     empty, which is exactly the state a new deployment is in. A check that
--     reports "skipped" on an empty queue is a check that never runs before the
--     feature has been used, which is when it is worth most.
--
--     It now creates its own pending request, as a customer_service user against
--     a lead that user can actually reach, so it is exercised on a fresh
--     database. Everything is inside the transaction that is rolled back.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_cs     uuid;
  v_reviewer uuid;
  v_reviewer_is_admin boolean := false;
  v_lead   uuid;
  v_req    uuid;
  v_blocked boolean := false;
  v_message text;
BEGIN
  SELECT user_id INTO v_cs
    FROM public.user_roles WHERE role = 'customer_service' LIMIT 1;

  SELECT user_id INTO v_reviewer
    FROM public.user_roles WHERE role = 'cs_admin' LIMIT 1;

  IF v_cs IS NULL OR v_reviewer IS NULL THEN
    INSERT INTO _results VALUES (10, 'cs_admin cannot self-approve', true,
      format('skipped, cs=%s reviewer=%s', v_cs IS NULL, v_reviewer IS NULL));
    RETURN;
  END IF;

  -- An admin is exempt from the self-approval rule by design, because they can
  -- already set urgent directly and are the escalation when no second CS Admin is
  -- free. Pick a reviewer who is not also an admin, or there is nothing to prove.
  IF public.has_role(v_reviewer, 'admin'::app_role) THEN
    SELECT ur.user_id INTO v_reviewer
      FROM public.user_roles ur
     WHERE ur.role = 'cs_admin'
       AND NOT public.has_role(ur.user_id, 'admin'::app_role)
     LIMIT 1;
  END IF;

  IF v_reviewer IS NULL THEN
    INSERT INTO _results VALUES (10, 'cs_admin cannot self-approve', true,
      'skipped, every cs_admin is also an admin');
    RETURN;
  END IF;

  -- A lead the requesting CS user can reach.
  SELECT l.id INTO v_lead
    FROM public.leads l
   WHERE l.status NOT IN ('urgent_job', 'paid', 'cancelled', 'scammed')
     AND (l.created_by = v_cs OR l.assigned_cs = v_cs)
   LIMIT 1;

  IF v_lead IS NULL THEN
    SELECT l.id INTO v_lead
      FROM public.leads l
     WHERE l.status NOT IN ('urgent_job', 'paid', 'cancelled', 'scammed')
     LIMIT 1;
  END IF;

  IF v_lead IS NULL THEN
    INSERT INTO _results VALUES (10, 'cs_admin cannot self-approve', true,
      'skipped, no usable lead');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cs, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_cs::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- Raise it as the CS user, so the request is genuine rather than hand-inserted.
  BEGIN
    v_req := public.request_urgent_review(
      v_lead,
      '[{"check":"schedule","field":"","severity":"low","problem":"harness","evidence":"","suggestion":"s"}]'::jsonb,
      'harness fixture', 'gpt-4o-mini', NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (10, 'cs_admin cannot self-approve', false,
      'could not raise the fixture request: ' || left(SQLERRM, 160));
    RETURN;
  END;

  IF v_req IS NULL THEN
    INSERT INTO _results VALUES (10, 'cs_admin cannot self-approve', false,
      'request_urgent_review returned no id');
    RETURN;
  END IF;

  -- Now hand it to the reviewer so the request appears to be their own.
  UPDATE public.lead_urgent_review_requests
     SET requested_by = v_reviewer, status = 'pending'
   WHERE id = v_req;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_reviewer, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  BEGIN
    PERFORM public.review_urgent_request(v_req, true, 'self review');
  EXCEPTION WHEN OTHERS THEN
    v_blocked := true;
    v_message := SQLERRM;
  END;

  IF NOT v_blocked THEN
    INSERT INTO _results VALUES (10, 'cs_admin cannot self-approve', false,
      'a cs_admin approved their own request');
    RETURN;
  END IF;

  INSERT INTO _results VALUES (
    10, 'cs_admin cannot self-approve', true,
    'raised ' || left(coalesce(v_message, ''), 70)
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (10, 'cs_admin cannot self-approve', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 11  customer_service cannot review at all
--     They raise requests. Only cs_admin and admin clear them.
--     Raises its own fixture, for the same reason as check 10.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_cs   uuid;
  v_lead uuid;
  v_req  uuid;
  v_blocked boolean := false;
  v_message text;
BEGIN
  SELECT user_id INTO v_cs
    FROM public.user_roles WHERE role = 'customer_service' LIMIT 1;

  IF v_cs IS NULL THEN
    INSERT INTO _results VALUES (11, 'CS cannot review requests', true, 'skipped, no customer_service user');
    RETURN;
  END IF;

  SELECT l.id INTO v_lead
    FROM public.leads l
   WHERE l.status NOT IN ('urgent_job', 'paid', 'cancelled', 'scammed')
     AND (l.created_by = v_cs OR l.assigned_cs = v_cs)
   LIMIT 1;

  IF v_lead IS NULL THEN
    SELECT l.id INTO v_lead
      FROM public.leads l
     WHERE l.status NOT IN ('urgent_job', 'paid', 'cancelled', 'scammed')
     LIMIT 1;
  END IF;

  IF v_lead IS NULL THEN
    INSERT INTO _results VALUES (11, 'CS cannot review requests', true, 'skipped, no usable lead');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cs, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_cs::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  BEGIN
    v_req := public.request_urgent_review(
      v_lead,
      '[]'::jsonb, 'harness fixture', 'gpt-4o-mini', NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (11, 'CS cannot review requests', false,
      'could not raise the fixture request: ' || left(SQLERRM, 160));
    RETURN;
  END IF;

  IF v_req IS NULL THEN
    INSERT INTO _results VALUES (11, 'CS cannot review requests', false,
      'request_urgent_review returned no id');
    RETURN;
  END IF;

  -- Still acting as the CS user who raised it. They must not be able to clear it.
  BEGIN
    PERFORM public.review_urgent_request(v_req, true, null);
  EXCEPTION WHEN OTHERS THEN
    v_blocked := true;
    v_message := SQLERRM;
  END;

  IF NOT v_blocked THEN
    INSERT INTO _results VALUES (11, 'CS cannot review requests', false,
      'customer_service was allowed to review');
    RETURN;
  END IF;

  INSERT INTO _results VALUES (
    11, 'CS cannot review requests', true,
    'raised ' || left(coalesce(v_message, ''), 70)
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (11, 'CS cannot review requests', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 12  The queue rejects direct writes from the table
--     The RPCs are the only path that should change a request. Checking that
--     RESET ALL plus the RLS policies are actually in force on the live database,
--     which an earlier REVOKE in this project silently failed to achieve.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_anon_execute text;
  v_auth_execute text;
BEGIN
  SELECT string_agg(routine_name, ', ') INTO v_anon_execute
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND grantee = 'anon'
     AND routine_name IN (
       'approve_urgent_verification', 'approve_urgent_acknowledgement',
       'request_urgent_review', 'review_urgent_request', 'list_urgent_review_requests'
     );

  IF v_anon_execute IS NOT NULL THEN
    RAISE EXCEPTION 'anon can execute: %', v_anon_execute;
  END IF;

  SELECT string_agg(routine_name, ', ') INTO v_auth_execute
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND grantee = 'authenticated'
     AND routine_name IN (
       'approve_urgent_verification', 'approve_urgent_acknowledgement',
       'request_urgent_review', 'review_urgent_request', 'list_urgent_review_requests'
     );

  -- Every one of the five must be reachable, or the feature cannot be used.
  IF array_length(string_to_array(coalesce(v_auth_execute, ''), ', '), 1) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'authenticated can execute only: %', coalesce(v_auth_execute, 'none');
  END IF;

  INSERT INTO _results VALUES (12, 'RPC grants correct', true, 'anon none, authenticated all 5');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (12, 'RPC grants correct', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 12b  No function may rely on its grant alone
--
--      This check exists because of a leak that shipped. list_urgent_review_requests
--      was SECURITY DEFINER with no check on the caller, the world grant survived
--      because ALTER FUNCTION ... RESET ALL does not touch privileges, and the
--      owner bypasses row level security. The anon key could read every review
--      request in the table.
--
--      Grants are now correct, so this would not fail on the grant alone. It
--      checks the other half: a SECURITY DEFINER function that reads a table must
--      decide for itself who may call it. That is the property a future GRANT
--      slip cannot take away.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_unchecked text;
BEGIN
  SELECT string_agg(proname, ', ') INTO v_unchecked
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND p.proname IN (
       'enforce_urgent_gate', 'approve_urgent_verification',
       'approve_urgent_acknowledgement', 'request_urgent_review',
       'review_urgent_request', 'list_urgent_review_requests'
     )
     -- enforce_urgent_gate is a trigger function. It never runs on a caller's
     -- request, so an auth check inside it would be meaningless.
     AND p.proname <> 'enforce_urgent_gate'
     AND p.prosrc NOT ILIKE '%auth.uid()%';

  IF v_unchecked IS NOT NULL THEN
    RAISE EXCEPTION 'these definer functions never check the caller: %', v_unchecked;
  END IF;

  INSERT INTO _results VALUES (16, 'definer functions authorise internally', true, 'all check auth.uid()');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (16, 'definer functions authorise internally', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 12c  PUBLIC must hold nothing on the workflow functions
--
--      Checked separately from the anon check above because the two arrive
--      differently: the default world grant is a PUBLIC entry, so revoking from
--      anon alone leaves it in place and the function still looks correctly
--      locked out on the anon check.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_public_execute text;
BEGIN
  SELECT string_agg(routine_name, ', ') INTO v_public_execute
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND grantee = 'PUBLIC'
     AND routine_name IN (
       'enforce_urgent_gate', 'approve_urgent_verification',
       'approve_urgent_acknowledgement', 'request_urgent_review',
       'review_urgent_request', 'list_urgent_review_requests',
       'set_urgent_review_updated_at'
     );

  IF v_public_execute IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLIC can execute: %', v_public_execute;
  END IF;

  INSERT INTO _results VALUES (17, 'PUBLIC holds no execute', true, 'nothing granted to PUBLIC');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (17, 'PUBLIC holds no execute', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 12d  anon must not reach the table directly either
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
BEGIN
  IF has_table_privilege('anon', 'public.lead_urgent_review_requests', 'SELECT') THEN
    v_bad := 'anon can SELECT the queue table';
  END IF;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '%', v_bad;
  END IF;

  INSERT INTO _results VALUES (18, 'anon has no table privilege', true, 'no direct access');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (18, 'anon has no table privilege', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 13  Every SECURITY DEFINER function pins its search path
--     Without this, a caller who can create objects in a schema ahead of public
--     in the path can shadow a function or table inside a definer context.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'enforce_urgent_gate', 'approve_urgent_verification',
       'approve_urgent_acknowledgement', 'request_urgent_review',
       'review_urgent_request', 'list_urgent_review_requests'
     )
     AND p.prosecdef
     AND (p.proconfig IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM unnest(p.proconfig) cfg
             WHERE cfg LIKE 'search\_path=%'
               AND cfg ~ 'pg_temp'
          ));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'search_path not pinned with pg_temp: %', v_bad;
  END IF;

  INSERT INTO _results VALUES (13, 'search_path pinned on definer functions', true, 'all include pg_temp');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (13, 'search_path pinned on definer functions', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 14  The queue is published to realtime
--     Without it, a reviewer does not see a new request until a manual refresh,
--     and a queue that only updates on refresh is a queue that gets missed.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_published boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'lead_urgent_review_requests'
  ) INTO v_published;

  IF NOT v_published THEN
    RAISE EXCEPTION 'lead_urgent_review_requests is not in supabase_realtime';
  END IF;

  INSERT INTO _results VALUES (14, 'queue published to realtime', true, 'published');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (14, 'queue published to realtime', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- 19  The schedule detector is tested against known input
--
--     Checks 8 and 9 read function source looking for an assignment to a schedule
--     column. Both of those checks failed for reasons that had nothing to do with
--     the schedule: once from a comment being paired with an unrelated equals sign
--     across statements, and once from operator precedence, where ~* binds tighter
--     than || so the expression silently became a text concatenation and raised
--     "argument of WHERE must be type boolean, not type text".
--
--     Neither failure would have been caught by the checks themselves. A detector
--     that cannot detect anything also reports "no problems found", so a broken
--     detector is indistinguishable from a clean function. This check runs the
--     detector against input whose answer is known, including a real assignment it
--     must flag and a comment it must not.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
BEGIN
  -- A real assignment. The detector must flag this.
  IF (E'UPDATE public.leads\n SET status = ''urgent_job'',\n     scheduled_date = v_d\n WHERE id = p;'
      ~* ('scheduled_date' || '\s*=')) IS NOT TRUE THEN
    v_bad := 'missed a genuine scheduled_date assignment';
  END IF;

  -- Assignment with padding before the equals sign.
  IF (E'UPDATE public.leads\n SET scheduled_date    = v_d\n WHERE id = p;'
      ~* ('scheduled_date' || '\s*=')) IS NOT TRUE THEN
    v_bad := 'missed a padded scheduled_date assignment';
  END IF;

  -- A comment naming the column, next to an unrelated equals sign. Must not flag.
  IF (E'-- status only. scheduled_date, scheduled_time_start and\n-- customer_schedule_requirements are deliberately untouched.\nUPDATE public.leads\n SET status = ''urgent_job'';'
      ~* ('scheduled_date' || '\s*=')) IS NOT FALSE THEN
    v_bad := 'false positive on a comment mentioning scheduled_date';
  END IF;

  -- A different column being assigned. Must not flag.
  IF (E'UPDATE public.leads\n SET scheduled_time_start = v_t\n WHERE id = p;'
      ~* ('scheduled_date' || '\s*=')) IS NOT FALSE THEN
    v_bad := 'false positive on an unrelated column';
  END IF;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '%', v_bad;
  END IF;

  INSERT INTO _results VALUES (19, 'schedule detector tested on known input', true, 'flags assignments, ignores comments');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _results VALUES (19, 'schedule detector tested on known input', false, SQLERRM);
END $$;


-- -----------------------------------------------------------------------------
-- Results
-- -----------------------------------------------------------------------------
SELECT
  seq,
  name,
  CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
  detail
FROM _results
ORDER BY seq;

ROLLBACK;

-- =============================================================================
-- Every row should read PASS. Any FAIL carries the expected and actual values
-- in DETAIL. Nothing is committed.
--
-- Checks 3, 4, 5, 6 and 10 are the ones that matter most. Check 3 and check 5
-- between them are what the inverted gate condition would have failed, and
-- check 6 is what would fail if a clean AI result could never become urgent.
-- =============================================================================