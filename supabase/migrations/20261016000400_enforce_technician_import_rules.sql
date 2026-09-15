-- Reject incomplete technicians and duplicate phone numbers regardless of the
-- client used to create them. Legacy rows remain untouched until edited.
CREATE OR REPLACE FUNCTION public.validate_technician_required_and_unique()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized_phone text;
BEGIN
  IF btrim(COALESCE(NEW.name, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'Technician name is required';
  END IF;
  IF btrim(COALESCE(NEW.opr_code, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'OPR code is required';
  END IF;
  IF btrim(COALESCE(NEW.service, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'Technician service is required';
  END IF;
  IF btrim(COALESCE(NEW.area, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'Technician area is required';
  END IF;

  normalized_phone := regexp_replace(COALESCE(NEW.phone_number, ''), '\D', '', 'g');
  IF length(normalized_phone) = 11 AND normalized_phone LIKE '1%' THEN
    normalized_phone := substring(normalized_phone FROM 2);
  END IF;
  IF length(normalized_phone) <> 10 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A valid 10-digit technician phone number is required';
  END IF;

  -- Prevent two simultaneous inserts from passing the duplicate check together.
  PERFORM pg_advisory_xact_lock(hashtext('technician-phone:' || normalized_phone));

  IF EXISTS (
    SELECT 1
    FROM public.technicians existing
    WHERE existing.id IS DISTINCT FROM NEW.id
      AND (
        CASE
          WHEN length(regexp_replace(COALESCE(existing.phone_number, ''), '\D', '', 'g')) = 11
            AND regexp_replace(COALESCE(existing.phone_number, ''), '\D', '', 'g') LIKE '1%'
          THEN substring(regexp_replace(existing.phone_number, '\D', '', 'g') FROM 2)
          ELSE regexp_replace(COALESCE(existing.phone_number, ''), '\D', '', 'g')
        END
      ) = normalized_phone
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Duplicate technician phone number';
  END IF;

  NEW.opr_code := upper(btrim(NEW.opr_code));
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_technician_required_and_unique() FROM PUBLIC;

DROP TRIGGER IF EXISTS technicians_validate_required_and_unique ON public.technicians;
CREATE TRIGGER technicians_validate_required_and_unique
  BEFORE INSERT OR UPDATE OF name, opr_code, phone_number, service, area
  ON public.technicians
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_technician_required_and_unique();
