CREATE OR REPLACE FUNCTION public.begin_google_sheets_full_reconcile()
RETURNS TABLE (lock_token uuid, queued integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_token uuid := gen_random_uuid();
  v_queued integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.google_sheets_sync_health (id, status, updated_at)
  VALUES ('global', 'healthy', now())
  ON CONFLICT (id) DO NOTHING;
  PERFORM 1 FROM public.google_sheets_sync_health WHERE id = 'global' FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.google_sheets_sync_health
              WHERE id = 'global' AND (reconcile_active OR reconcile_lock_until > now())) THEN
    RAISE EXCEPTION 'A full Google Sheets rebuild is already running'
      USING ERRCODE = '55P03';
  END IF;
  IF EXISTS (SELECT 1 FROM public.google_sheets_sync_queue
              WHERE lease_until > now()) THEN
    RAISE EXCEPTION 'A delivery batch is in flight; retry the rebuild in a moment'
      USING ERRCODE = '55P03';
  END IF;

  UPDATE public.google_sheets_sync_health
     SET reconcile_lock_token = v_token,
         reconcile_lock_until = now() + interval '10 minutes',
         reconcile_active = true,
         reconcile_clear_pending = true,
         watermark_at = NULL,
         updated_at = now()
   WHERE id = 'global';

  -- The production DELETE guard requires an explicit filter. TRUE intentionally
  -- retains the full-replacement behavior for this admin RPC.
  DELETE FROM public.google_sheets_sync_queue WHERE true;
  INSERT INTO public.google_sheets_sync_queue (lead_id, op, job_id, attempts, next_attempt_at)
  SELECT l.id, 'upsert', l.job_id, 0, now()
    FROM public.leads l;
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN QUERY SELECT v_token, v_queued;
END;
$fn$;
