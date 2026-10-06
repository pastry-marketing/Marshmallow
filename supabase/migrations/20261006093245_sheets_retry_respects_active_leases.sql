CREATE OR REPLACE FUNCTION public.retry_sheets_sync_queue_now(p_limit integer DEFAULT 10)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_rows integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin or the sync worker may retry jobs'
      USING ERRCODE = '42501';
  END IF;

  WITH selected AS (
    SELECT q.lead_id
      FROM public.google_sheets_sync_queue q
     WHERE q.lease_until IS NULL OR q.lease_until < now()
     ORDER BY q.enqueued_at
     LIMIT greatest(1, least(coalesce(p_limit, 10), 10))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.google_sheets_sync_queue q
     SET attempts = 0,
         next_attempt_at = now(),
         lease_token = NULL,
         lease_until = NULL,
         updated_at = now()
    FROM selected s
   WHERE q.lead_id = s.lead_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

REVOKE ALL ON FUNCTION public.retry_sheets_sync_queue_now(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_sheets_sync_queue_now(integer)
  TO service_role;
