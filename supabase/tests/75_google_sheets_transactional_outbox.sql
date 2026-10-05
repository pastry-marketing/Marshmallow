-- =============================================================================
-- Harness : 75_google_sheets_transactional_outbox.sql
-- Purpose : Prove CRM changes enter the durable Sheets outbox transactionally,
--           notes/photos enqueue the owning lead, and an old worker ack cannot
--           erase a newer change.
--
-- HOW TO RUN
--   Apply 20261106010000_reliable_google_sheets_outbox.sql, then run this in
--   the Supabase SQL Editor. Expected: every row reads PASS.
--
--   Everything is inside a transaction and rolled back. It uses a scratch lead
--   and temporarily edits existing note/photo rows without changing their final
--   contents.
-- =============================================================================

BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';
DO $$
DECLARE v_admin uuid;
BEGIN
  SELECT user_id INTO v_admin FROM public.user_roles WHERE role = 'admin' LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'Harness requires an Admin user'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_admin::text, 'role', 'service_role'
  )::text, true);
END $$;

CREATE TEMP TABLE _outbox_results (
  seq integer PRIMARY KEY,
  name text NOT NULL,
  ok boolean NOT NULL,
  detail text
) ON COMMIT DROP;

-- The deployment migration seeds existing leads into the queue. Keep this
-- transaction isolated so the lease test deterministically claims its probe.
DELETE FROM public.google_sheets_sync_queue;

-- 01  All three source tables have transactional enqueue triggers.
DO $$
DECLARE
  v_lead boolean;
  v_notes boolean;
  v_photos boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.leads'::regclass AND tgname = 'leads_google_sheets_outbox' AND NOT tgisinternal)
    INTO v_lead;
  SELECT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.lead_notes'::regclass AND tgname = 'lead_notes_google_sheets_outbox' AND NOT tgisinternal)
    INTO v_notes;
  SELECT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.lead_photos'::regclass AND tgname = 'lead_photos_google_sheets_outbox' AND NOT tgisinternal)
    INTO v_photos;

  INSERT INTO _outbox_results
  VALUES (1, 'lead/note/photo triggers installed', v_lead AND v_notes AND v_photos,
          format('leads=%s notes=%s photos=%s', v_lead, v_notes, v_photos));
END $$;

-- 02  Lead writes enqueue/coalesce; updating a lead twice produces one row and
--     advances the generation twice.
DO $$
DECLARE
  v_lead uuid;
  v_rows integer;
  v_generation bigint;
  v_previous_statuses text[];
BEGIN
  INSERT INTO public.leads
    (job_id, customer_name, customer_phone, service_type, status)
  VALUES
    ('ZZ-SHEETS-OUTBOX-' || gen_random_uuid()::text, 'Sheets outbox probe', '9999000001',
     'General', 'waiting_complete_details')
  RETURNING id INTO v_lead;

  UPDATE public.leads SET customer_name = 'Sheets outbox probe 2' WHERE id = v_lead;
  UPDATE public.leads SET customer_name = 'Sheets outbox probe 3' WHERE id = v_lead;
  UPDATE public.leads SET status = 'scheduled' WHERE id = v_lead;
  UPDATE public.leads SET status = 'job_done' WHERE id = v_lead;

  SELECT count(*), max(generation)
    INTO v_rows, v_generation
    FROM public.google_sheets_sync_queue WHERE lead_id = v_lead;
  SELECT previous_statuses INTO v_previous_statuses
    FROM public.google_sheets_sync_queue WHERE lead_id = v_lead;

  INSERT INTO _outbox_results
  VALUES (2, 'lead updates coalesce and retain old statuses',
          v_rows = 1 AND v_generation >= 5
            AND v_previous_statuses @> ARRAY['waiting_complete_details', 'scheduled']::text[],
          format('rows=%s generation=%s old_statuses=%s', v_rows, v_generation, v_previous_statuses));

  DELETE FROM public.leads WHERE id = v_lead;
  INSERT INTO _outbox_results
  SELECT 3, 'lead delete becomes a durable tombstone',
         EXISTS (SELECT 1 FROM public.google_sheets_sync_queue
                  WHERE lead_id = v_lead AND op = 'delete' AND job_id IS NOT NULL),
         'delete op retains job_id after lead row is gone';
  DELETE FROM public.google_sheets_sync_queue WHERE lead_id = v_lead;
END $$;

-- 03  An in-flight older generation cannot clear a newer mutation.
DO $$
DECLARE
  v_lead uuid;
  v_job text;
  v_claim record;
  v_finished boolean;
  v_generation bigint;
  v_lease uuid;
  v_remaining integer;
BEGIN
  INSERT INTO public.leads
    (job_id, customer_name, customer_phone, service_type, status)
  VALUES
    ('ZZ-SHEETS-LEASE-' || gen_random_uuid()::text, 'Sheets lease probe', '9999000002',
     'General', 'waiting_complete_details')
  RETURNING id, job_id INTO v_lead, v_job;

  SELECT * INTO v_claim
    FROM public.claim_sheets_sync_queue(100)
   WHERE lead_id = v_lead;

  IF v_claim.lead_id IS NULL THEN
    RAISE EXCEPTION 'new outbox row was not claimable';
  END IF;
  v_generation := v_claim.generation;
  v_lease := v_claim.lease_token;

  UPDATE public.leads SET customer_name = 'Changed during lease' WHERE id = v_lead;

  SELECT public.finish_sheets_sync_job(
           v_lead, v_generation, v_lease, true, NULL, NULL
         ) INTO v_finished;
  SELECT count(*) INTO v_remaining FROM public.google_sheets_sync_queue WHERE lead_id = v_lead;

  INSERT INTO _outbox_results
  VALUES (4, 'stale worker ack preserves newer edit',
          NOT v_finished AND v_remaining = 1,
          format('old_ack=%s queue_rows=%s', v_finished, v_remaining));
END $$;

-- 05  Note and photo changes reach the outbox using their lead_id.
DO $$
DECLARE
  v_note_lead uuid;
  v_photo_lead uuid;
  v_note_count integer := 0;
  v_photo_count integer := 0;
BEGIN
  SELECT lead_id INTO v_note_lead FROM public.lead_notes LIMIT 1;
  IF v_note_lead IS NOT NULL THEN
    DELETE FROM public.google_sheets_sync_queue WHERE lead_id = v_note_lead;
    UPDATE public.lead_notes SET content = content WHERE lead_id = v_note_lead;
    SELECT count(*) INTO v_note_count FROM public.google_sheets_sync_queue
     WHERE lead_id = v_note_lead AND op = 'upsert';
  END IF;

  SELECT lead_id INTO v_photo_lead FROM public.lead_photos LIMIT 1;
  IF v_photo_lead IS NOT NULL THEN
    DELETE FROM public.google_sheets_sync_queue WHERE lead_id = v_photo_lead;
    UPDATE public.lead_photos SET photo_url = photo_url WHERE lead_id = v_photo_lead;
    SELECT count(*) INTO v_photo_count FROM public.google_sheets_sync_queue
     WHERE lead_id = v_photo_lead AND op = 'upsert';
  END IF;

  INSERT INTO _outbox_results
  VALUES (5, 'note/photo mutations enqueue their lead',
          (v_note_lead IS NULL OR v_note_count = 1)
          AND (v_photo_lead IS NULL OR v_photo_count = 1),
          format('notes=%s photos=%s (zero means that source table has no rows to probe)',
                 v_note_count, v_photo_count));
END $$;

-- 06  A full Sheet rebuild pauses the worker, replaces the outbox with the
--     current CRM snapshot, then releases the lease for background delivery.
DO $$
DECLARE
  v_lock uuid;
  v_queued integer;
  v_claimed integer;
  v_released boolean;
  v_expected bigint;
BEGIN
  SELECT count(*) INTO v_expected FROM public.leads;
  SELECT lock_token, queued INTO v_lock, v_queued
    FROM public.begin_google_sheets_full_reconcile();

  SELECT count(*) INTO v_claimed FROM public.claim_sheets_sync_queue(25);
  SELECT public.finish_google_sheets_full_reconcile(v_lock) INTO v_released;

  INSERT INTO _outbox_results
  VALUES (6, 'full reconcile pause/snapshot/release',
          v_lock IS NOT NULL AND v_queued = v_expected AND v_claimed = 0 AND v_released,
          format('queued=%s expected=%s claimed_while_locked=%s released=%s',
                 v_queued, v_expected, v_claimed, v_released));
END $$;

SELECT seq, name, ok, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
  FROM _outbox_results
 ORDER BY seq;

ROLLBACK;
