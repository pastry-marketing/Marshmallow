-- OPR Admin inherits OPR lead access, and every OPR-role assignment receives a code.

-- Serialize code allocation so simultaneous user creation cannot choose the same number.
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
  PERFORM pg_advisory_xact_lock(hashtext('public.profiles.opr_code'));

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

CREATE OR REPLACE FUNCTION public.ensure_opr_code_on_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IN ('opr', 'opr_admin') THEN
    PERFORM public.assign_next_opr_code(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_roles_assign_opr_code ON public.user_roles;
CREATE TRIGGER user_roles_assign_opr_code
  AFTER INSERT OR UPDATE OF role ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_opr_code_on_role_assignment();

-- Repair existing OPR accounts that still have no code.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ur.user_id
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role IN ('opr', 'opr_admin')
      AND COALESCE(p.opr_code, '') = ''
  LOOP
    PERFORM public.assign_next_opr_code(r.user_id);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Authorized users can update leads" ON public.leads;
CREATE POLICY "Authorized users can update leads"
  ON public.leads FOR UPDATE TO authenticated
  USING (
    created_by = auth.uid() OR assigned_cs = auth.uid()
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'processor'::public.app_role)
    OR public.has_role(auth.uid(), 'opr'::public.app_role)
    OR public.has_role(auth.uid(), 'opr_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'cs_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'customer_service'::public.app_role)
  )
  WITH CHECK (
    (created_by = auth.uid() OR assigned_cs = auth.uid()
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'processor'::public.app_role)
      OR public.has_role(auth.uid(), 'opr'::public.app_role)
      OR public.has_role(auth.uid(), 'opr_admin'::public.app_role)
      OR public.has_role(auth.uid(), 'cs_admin'::public.app_role)
      OR public.has_role(auth.uid(), 'customer_service'::public.app_role))
    AND (public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'processor'::public.app_role)
      OR public.has_role(auth.uid(), 'opr'::public.app_role)
      OR public.has_role(auth.uid(), 'opr_admin'::public.app_role)
      OR status <> 'scammed')
    AND (NOT public.has_role(auth.uid(), 'cs_admin'::public.app_role)
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'processor'::public.app_role)
      OR public.has_role(auth.uid(), 'opr'::public.app_role)
      OR public.has_role(auth.uid(), 'opr_admin'::public.app_role)
      OR status NOT IN ('paid','partial_paid','cancelled','job_done','scammed'))
  );

DROP POLICY IF EXISTS "Scoped lead access" ON public.leads;
CREATE POLICY "Scoped lead access" ON public.leads FOR SELECT TO authenticated
USING (
  CASE
    WHEN public.has_role(auth.uid(), 'admin'::public.app_role) THEN TRUE
    WHEN public.has_role(auth.uid(), 'processor'::public.app_role) THEN TRUE
    WHEN public.has_role(auth.uid(), 'opr'::public.app_role) THEN TRUE
    WHEN public.has_role(auth.uid(), 'opr_admin'::public.app_role) THEN TRUE
    WHEN public.has_role(auth.uid(), 'cs_admin'::public.app_role) THEN
      status NOT IN ('paid','partial_paid','cancelled','job_done','scammed')
    ELSE status <> 'scammed' AND (
      created_by = auth.uid() OR assigned_cs = auth.uid()
      OR EXISTS (SELECT 1 FROM public.lead_shares
        WHERE lead_shares.lead_id = leads.id
          AND lead_shares.shared_with_user_id = auth.uid())
    )
  END
);

DROP POLICY IF EXISTS "Users can view accessible leads" ON public.leads;
CREATE POLICY "Users can view accessible leads" ON public.leads FOR SELECT TO authenticated
USING (
  created_by = auth.uid() OR assigned_cs = auth.uid()
  OR public.has_role(auth.uid(), 'admin'::public.app_role)
  OR public.has_role(auth.uid(), 'processor'::public.app_role)
  OR public.has_role(auth.uid(), 'opr'::public.app_role)
  OR public.has_role(auth.uid(), 'opr_admin'::public.app_role)
  OR EXISTS (SELECT 1 FROM public.lead_shares
    WHERE lead_shares.lead_id = leads.id
      AND lead_shares.shared_with_user_id = auth.uid())
);

DROP POLICY IF EXISTS "Self or admin can create notifications" ON public.notifications;
CREATE POLICY "Self or admin can create notifications" ON public.notifications
FOR INSERT TO authenticated WITH CHECK (
  user_id = auth.uid()
  OR public.has_role(auth.uid(), 'admin'::public.app_role)
  OR public.has_role(auth.uid(), 'processor'::public.app_role)
  OR public.has_role(auth.uid(), 'opr'::public.app_role)
  OR public.has_role(auth.uid(), 'opr_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'cs_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'customer_service'::public.app_role)
);
