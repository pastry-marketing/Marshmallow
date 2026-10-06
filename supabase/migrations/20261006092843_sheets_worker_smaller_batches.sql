-- Keep Apps Script mirror requests below its web-app execution/request timeout.
-- The durable queue is processed by successive one-minute worker invocations.
CREATE OR REPLACE FUNCTION public.cron_google_sheets_sync_worker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_project_url text;
  v_publishable_key text;
  v_cron_secret text;
BEGIN
  SELECT decrypted_secret INTO v_project_url
    FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_publishable_key
    FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1;
  SELECT CASE
      WHEN jsonb_typeof(value) = 'array' THEN value ->> 0
      WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}'
      WHEN jsonb_typeof(value) = 'object' THEN value ->> 'secret'
      ELSE NULL
    END
    INTO v_cron_secret
    FROM public.quo_ai_settings WHERE key = 'cron_secret' LIMIT 1;

  IF coalesce(v_project_url, '') = ''
     OR coalesce(v_publishable_key, '') = ''
     OR coalesce(v_cron_secret, '') = '' THEN
    RAISE WARNING 'Google Sheets outbox worker not invoked: project_url, publishable_key, or cron_secret is missing';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/google-sheets-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_publishable_key,
      'x-cron-secret', v_cron_secret
    ),
    body := jsonb_build_object('action', 'process_queue', 'limit', 10),
    timeout_milliseconds := 60000
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_google_sheets_sync_worker()
  FROM PUBLIC, anon, authenticated;
