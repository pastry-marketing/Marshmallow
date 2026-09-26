-- Quote approval gate
-- CS users request approval before a lead can enter Pending to Send. CS Admins
-- and Admins review the request; approval moves the lead into the existing
-- quotation-master queue and decline leaves the lead at its previous status.

CREATE TABLE public.lead_quote_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  previous_status text NOT NULL,
  lead_job_id text,
  lead_customer_name text,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  requested_by_name text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined')),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_by_name text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lead_quote_approval_one_pending_per_lead_idx
  ON public.lead_quote_approval_requests (lead_id)
  WHERE status = 'pending';

CREATE INDEX lead_quote_approval_pending_created_idx
  ON public.lead_quote_approval_requests (created_at DESC)
  WHERE status = 'pending';

CREATE INDEX lead_quote_approval_requested_by_idx
  ON public.lead_quote_approval_requests (requested_by);

CREATE INDEX lead_quote_approval_reviewed_by_idx
  ON public.lead_quote_approval_requests (reviewed_by);

ALTER TABLE public.lead_quote_approval_requests ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_access_quote_approval()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN public.has_role(auth.uid(), 'admin'::public.app_role) THEN true
    WHEN EXISTS (
      SELECT 1
      FROM public.navigation_permissions AS permission
      WHERE permission.user_id = auth.uid()
        AND permission.nav_section = 'quote_approval_requests'
    ) THEN COALESCE((
      SELECT permission.allowed
      FROM public.navigation_permissions AS permission
      WHERE permission.user_id = auth.uid()
        AND permission.nav_section = 'quote_approval_requests'
      LIMIT 1
    ), false)
    ELSE public.has_role(auth.uid(), 'customer_service'::public.app_role)
      OR public.has_role(auth.uid(), 'cs_admin'::public.app_role)
  END;
$$;

REVOKE ALL ON FUNCTION public.can_access_quote_approval() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_quote_approval() TO authenticated, service_role;

CREATE POLICY "Users with Quote Approval access can view requests"
  ON public.lead_quote_approval_requests
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.can_access_quote_approval())
    AND (
      NOT public.has_role((SELECT auth.uid()), 'customer_service'::public.app_role)
      OR requested_by = (SELECT auth.uid())
    )
  );

GRANT SELECT ON public.lead_quote_approval_requests TO authenticated;
GRANT ALL ON public.lead_quote_approval_requests TO service_role;

CREATE OR REPLACE FUNCTION public.request_quote_approval(_lead_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  requester_id uuid := auth.uid();
  requester_name text;
  lead_row public.leads%ROWTYPE;
  existing_request_id uuid;
  created_request_id uuid;
BEGIN
  IF requester_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to request quote approval';
  END IF;

  IF NOT public.has_role(requester_id, 'customer_service'::public.app_role) THEN
    RAISE EXCEPTION 'Only Customer Service users can request quote approval';
  END IF;

  IF NOT public.can_access_quote_approval() THEN
    RAISE EXCEPTION 'Quote Approval access is disabled for this user';
  END IF;

  SELECT lead.*
  INTO lead_row
  FROM public.leads AS lead
  WHERE lead.id = _lead_id
    AND (
      lead.created_by = requester_id
      OR lead.assigned_cs = requester_id
      OR EXISTS (
        SELECT 1
        FROM public.lead_shares AS share
        WHERE share.lead_id = lead.id
          AND share.shared_with_user_id = requester_id
      )
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found or you do not have access to it';
  END IF;

  IF lead_row.status = 'pending_to_send' THEN
    RAISE EXCEPTION 'This lead is already in Quotes to Send';
  END IF;

  SELECT request.id
  INTO existing_request_id
  FROM public.lead_quote_approval_requests AS request
  WHERE request.lead_id = _lead_id
    AND request.status = 'pending'
  LIMIT 1;

  IF existing_request_id IS NOT NULL THEN
    RETURN existing_request_id;
  END IF;

  SELECT profile.full_name
  INTO requester_name
  FROM public.profiles AS profile
  WHERE profile.id = requester_id;

  INSERT INTO public.lead_quote_approval_requests (
    lead_id,
    previous_status,
    lead_job_id,
    lead_customer_name,
    requested_by,
    requested_by_name
  ) VALUES (
    lead_row.id,
    lead_row.status,
    lead_row.job_id,
    lead_row.customer_name,
    requester_id,
    COALESCE(requester_name, 'Customer Service')
  )
  RETURNING id INTO created_request_id;

  RETURN created_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_quote_approval(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_quote_approval(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_quote_approval_request(
  _request_id uuid,
  _decision text,
  _review_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reviewer_id uuid := auth.uid();
  reviewer_name text;
  request_row public.lead_quote_approval_requests%ROWTYPE;
BEGIN
  IF reviewer_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to review quote approval';
  END IF;

  IF _decision NOT IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'Decision must be approved or declined';
  END IF;

  IF NOT (
    public.has_role(reviewer_id, 'admin'::public.app_role)
    OR public.has_role(reviewer_id, 'cs_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Only CS Admins or Admins can review quote approvals';
  END IF;

  IF NOT public.can_access_quote_approval() THEN
    RAISE EXCEPTION 'Quote Approval access is disabled for this user';
  END IF;

  SELECT request.*
  INTO request_row
  FROM public.lead_quote_approval_requests AS request
  WHERE request.id = _request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote approval request not found';
  END IF;

  IF request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This quote approval request has already been reviewed';
  END IF;

  SELECT profile.full_name
  INTO reviewer_name
  FROM public.profiles AS profile
  WHERE profile.id = reviewer_id;

  IF _decision = 'approved' THEN
    UPDATE public.leads
    SET status = 'pending_to_send',
        cs_tag = NULL,
        last_edited_by = reviewer_id,
        last_edited_by_name = COALESCE(reviewer_name, 'Admin'),
        last_edited_at = now(),
        updated_at = now()
    WHERE id = request_row.lead_id;

    -- The existing pending-to-send trigger records auth.uid(), which is the
    -- reviewer inside this RPC. Preserve the CS requester for later quote
    -- update notifications with a second non-status update.
    UPDATE public.leads
    SET quote_requested_by = request_row.requested_by
    WHERE id = request_row.lead_id;
  END IF;

  UPDATE public.lead_quote_approval_requests
  SET status = _decision,
      reviewed_by = reviewer_id,
      reviewed_by_name = COALESCE(reviewer_name, 'Admin'),
      reviewed_at = now(),
      review_note = NULLIF(btrim(_review_note), ''),
      updated_at = now()
  WHERE id = request_row.id;

  RETURN request_row.lead_id;
END;
$$;

REVOKE ALL ON FUNCTION public.review_quote_approval_request(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_quote_approval_request(uuid, text, text) TO authenticated, service_role;

-- Defense in depth: if an older client directly changes a CS lead to Pending
-- to Send, convert that attempt into an approval request and keep its current
-- status. Current clients call request_quote_approval directly for clear UI.
CREATE OR REPLACE FUNCTION public.route_cs_quote_to_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'pending_to_send'
    AND OLD.status IS DISTINCT FROM 'pending_to_send'
    AND public.has_role(auth.uid(), 'customer_service'::public.app_role)
  THEN
    PERFORM public.request_quote_approval(NEW.id);
    NEW.status := OLD.status;
    NEW.cs_tag := OLD.cs_tag;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.route_cs_quote_to_approval() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_cs_quote_to_approval() TO authenticated, service_role;

DROP TRIGGER IF EXISTS route_cs_quote_to_approval ON public.leads;
CREATE TRIGGER route_cs_quote_to_approval
  BEFORE UPDATE OF status ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.route_cs_quote_to_approval();

DROP TRIGGER IF EXISTS lead_quote_approval_set_updated_at ON public.lead_quote_approval_requests;
CREATE TRIGGER lead_quote_approval_set_updated_at
  BEFORE UPDATE ON public.lead_quote_approval_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lead_quote_approval_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_quote_approval_requests;
  END IF;
END;
$$;
