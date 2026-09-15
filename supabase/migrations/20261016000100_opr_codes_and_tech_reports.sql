-- OPR codes + technician ownership + report access flag.
--
-- Visibility of technicians by OPR is enforced in the app UI (per product
-- decision); these columns store the data the UI filters and reports on.

-- 1. Per-user OPR code (immutable, unique) and report-access flag ------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS opr_code text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS can_view_tech_report boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_opr_code_key
  ON public.profiles (opr_code) WHERE opr_code IS NOT NULL;

-- 2. Owning OPR for each technician (null = legacy, only admins see those) ----
ALTER TABLE public.technicians ADD COLUMN IF NOT EXISTS opr_code text;
CREATE INDEX IF NOT EXISTS technicians_opr_code_idx ON public.technicians (opr_code);

-- 3. Sequential OPR code assignment ------------------------------------------
-- Returns the user's existing code, or assigns the next OPR### and returns it.
CREATE OR REPLACE FUNCTION public.assign_next_opr_code(_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing text;
  nextnum int;
  newcode text;
BEGIN
  SELECT opr_code INTO existing FROM public.profiles WHERE id = _user_id;
  IF existing IS NOT NULL AND existing <> '' THEN
    RETURN existing;
  END IF;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(opr_code, '\D', '', 'g'), '')::int), 0) + 1
    INTO nextnum
    FROM public.profiles
    WHERE opr_code ~ '^OPR[0-9]+$';

  newcode := 'OPR' || lpad(nextnum::text, 3, '0');
  UPDATE public.profiles SET opr_code = newcode WHERE id = _user_id;
  RETURN newcode;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_next_opr_code(uuid) TO authenticated;

-- List every assigned OPR code with its owner's name, for the technician form's
-- OPR-code picker (works regardless of profiles row-level security).
CREATE OR REPLACE FUNCTION public.list_opr_codes()
RETURNS TABLE(opr_code text, full_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.opr_code, p.full_name
  FROM public.profiles p
  WHERE p.opr_code IS NOT NULL AND p.opr_code <> ''
  ORDER BY p.opr_code;
$$;

GRANT EXECUTE ON FUNCTION public.list_opr_codes() TO authenticated;

-- 4. Backfill: give every current opr / opr_admin user a code ----------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ur.user_id
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role IN ('opr', 'opr_admin')
      AND (p.opr_code IS NULL OR p.opr_code = '')
  LOOP
    PERFORM public.assign_next_opr_code(r.user_id);
  END LOOP;
END $$;
