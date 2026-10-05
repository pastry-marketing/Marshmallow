-- Require the same urgent review for customer_service, admin, and cs_admin.
-- Processor remains exempt because that role owns dispatch operations.
-- Verified/acknowledged transitions continue through the existing RPCs, which
-- set app.urgent_verified transaction-locally and leave the agreed schedule alone.

CREATE OR REPLACE FUNCTION public.enforce_urgent_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_bypass  boolean;
BEGIN
  v_bypass := public.has_role(v_uid, 'processor'::app_role);

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'urgent_job' AND NOT v_bypass THEN
      RAISE EXCEPTION
        'A new lead cannot be created as urgent. Create it first, then run the AI check before making it urgent.'
        USING ERRCODE = '42501',
              HINT = 'Create the lead in its normal status, then use the urgent check.';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'urgent_job' THEN
    RETURN NEW;
  END IF;

  IF v_bypass THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.urgent_verified', true) = 'on' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'This lead must pass the AI verification check before it can become urgent.'
    USING ERRCODE = '42501',
          HINT = 'Use the AI check on the lead before changing its status to Urgent.';
END;
$fn$;

COMMENT ON FUNCTION public.enforce_urgent_gate() IS
  'Blocks direct urgent inserts and status transitions for customer_service, '
  'admin, and cs_admin unless an urgent review RPC set the transaction-local '
  'verification flag. Processor remains exempt for dispatch operations.';

ALTER FUNCTION public.enforce_urgent_gate()
  SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.enforce_urgent_gate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_urgent_gate() TO service_role;
