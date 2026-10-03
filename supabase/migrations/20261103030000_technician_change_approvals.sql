-- =============================================================================
-- Migration : 20261103030000_technician_change_approvals.sql
-- Purpose   : Let a Processor ask for a technician flag change, and let an
--             Admin approve it, instead of the Processor writing the flag
--             directly.
--
-- WHY THIS CANNOT BE A UI GATE
--
--   The existing policy "Admin and Processor can update technicians" grants
--   UPDATE on every column of every technician row to processors. Row level
--   security filters rows, not columns, so today a processor can already set
--   is_good_tech and is_active with a single direct API call and no UI at all.
--
--   Adding a confirmation dialog to the Technicians page would therefore change
--   nothing about what a processor can actually do. The approval has to be
--   enforced below the application, or it is decoration.
--
-- WHAT IS ENFORCED HERE
--
--   A BEFORE INSERT OR UPDATE trigger on technicians refuses a change to
--   is_good_tech or is_active unless the caller is an admin. Nothing else can
--   move those two columns, through the app, through the REST API, or through
--   a direct PostgREST call.
--
--   A BEFORE UPDATE trigger rather than column-level privileges, because a
--   REVOKE/GRANT can be undone by the next migration that touches grants and
--   nobody reads the ACL. A trigger is a single place with a comment on it.
--
--   Admins keep writing the flags directly. Requiring an admin to approve their
--   own request would add a queue to satisfy nobody.
--
-- THE TWO FLAGS STAY INDEPENDENT
--
--   Clearing Good Tech does not deactivate a technician and deactivating does
--   not clear Good Tech. Each is requested on its own, which is why
--   change_type exists rather than a single combined status.
--
-- PERMISSIONS
--
--   Processor: insert a request, read their own and everyone else's requests
--   so the Technicians page can show who is waiting on what.
--   Admin: everything.
--   anon: nothing, and the SECURITY DEFINER functions are revoked from PUBLIC.
--
--   That last part is deliberate. These functions are SECURITY DEFINER, so they
--   bypass the policies on this table, and Postgres grants EXECUTE on a new
--   function to PUBLIC by default. Two earlier migrations in this project
--   shipped without that revoke and were only caught by querying the live
--   grants afterwards.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The request queue
--    Column shape follows lead_quote_approval_requests, including its
--    approved/declined vocabulary, so the two review queues behave alike.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.technician_change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id     uuid NOT NULL,
  -- Snapshotted so the queue still reads correctly if the technician is later
  -- deleted, and so an approval never has to join to render the row.
  technician_name   text NOT NULL,
  change_type       text NOT NULL,
  requested_value   boolean NOT NULL,
  -- Recorded so the queue can show "Good Tech: Yes to No" without re-reading
  -- the technician, and so an approval can detect that the flag moved
  -- underneath it while the request was waiting.
  previous_value    boolean,
  reason            text,
  requested_by      uuid NOT NULL,
  requested_by_name text,
  status            text NOT NULL DEFAULT 'pending',
  reviewed_by       uuid,
  reviewed_by_name  text,
  reviewed_at       timestamptz,
  review_note       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_change_requests_type
    CHECK (change_type IN ('set_good_tech', 'set_active')),
  CONSTRAINT technician_change_requests_status
    CHECK (status IN ('pending', 'approved', 'declined'))
);

COMMENT ON TABLE public.technician_change_requests IS
  'Processor-proposed changes to technician.is_good_tech and is_active. '
  'The technician row is untouched until an admin approves.';

-- One open request per technician per flag, so a processor cannot queue the
-- same change repeatedly and bury the queue.
CREATE UNIQUE INDEX IF NOT EXISTS technician_change_requests_one_pending
  ON public.technician_change_requests (technician_id, change_type)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS technician_change_requests_pending_idx
  ON public.technician_change_requests (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS technician_change_requests_requester_idx
  ON public.technician_change_requests (requested_by, created_at DESC);


-- -----------------------------------------------------------------------------
-- 2. updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_technician_change_request_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS technician_change_requests_updated_at
  ON public.technician_change_requests;

CREATE TRIGGER technician_change_requests_updated_at
  BEFORE UPDATE ON public.technician_change_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_technician_change_request_updated_at();


-- -----------------------------------------------------------------------------
-- 3. THE ENFORCEMENT
--    is_good_tech and is_active are admin-only columns. A processor writing
--    them directly is rejected by the database, not merely hidden in the UI.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_technician_flags_admin_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_is_admin boolean;
  v_flag_moved boolean := false;
  v_label   text;
BEGIN
  v_is_admin := public.has_role(v_uid, 'admin'::app_role);

  IF TG_OP = 'INSERT' THEN
    v_flag_moved := NEW.is_good_tech IS TRUE OR NEW.is_active IS FALSE;
    v_label      := 'insert a technician with Good Tech set or deactivated';
  ELSE
    v_flag_moved := NEW.is_good_tech IS DISTINCT FROM OLD.is_good_tech
                OR NEW.is_active     IS DISTINCT FROM OLD.is_active;
    v_label      := 'change Good Tech or active status';
  END IF;

  -- Fail only on a real move to the protected value, so an unrelated edit that
  -- happens to carry the existing values is not blocked.
  IF v_flag_moved AND NOT v_is_admin THEN
    RAISE EXCEPTION
      'Only an admin may % . Raise a technician change request instead.', v_label
      USING ERRCODE = '42501',
            HINT = 'Use the Technicians page to request this change for admin approval.';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.enforce_technician_flags_admin_only() IS
  'Blocks non-admins from writing technicians.is_good_tech and is_active. This '
  'is what makes the approval workflow real rather than cosmetic, because the '
  'pre-existing policy already lets a processor UPDATE every column.';

DROP TRIGGER IF EXISTS technicians_flags_admin_only ON public.technicians;

CREATE TRIGGER technicians_flags_admin_only
  BEFORE INSERT OR UPDATE ON public.technicians
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_technician_flags_admin_only();


-- -----------------------------------------------------------------------------
-- 4. Processor raises a request
--    Reads the current value server-side so previous_value cannot be spoofed
--    by the client.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_technician_change(
  p_technician_id uuid,
  p_change_type   text,
  p_requested_value boolean,
  p_reason        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_name     text;
  v_current  boolean;
  v_target   text;
  v_existing uuid;
  v_profile  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_role(v_uid, 'processor'::app_role)
     AND NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only a processor can raise a technician change request'
      USING ERRCODE = '42501';
  END IF;

  IF p_change_type NOT IN ('set_good_tech', 'set_active') THEN
    RAISE EXCEPTION 'Unknown change type: %', p_change_type USING ERRCODE = '22023';
  END IF;

  SELECT t.name,
         CASE WHEN p_change_type = 'set_good_tech' THEN COALESCE(t.is_good_tech, false)
              ELSE t.is_active END
    INTO v_name, v_current
    FROM public.technicians t
   WHERE t.id = p_technician_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Technician not found' USING ERRCODE = 'P0002';
  END IF;

  -- Nothing to approve if the value already matches.
  IF v_current IS NOT DISTINCT FROM p_requested_value THEN
    v_target := CASE WHEN p_change_type = 'set_good_tech' THEN 'Good Tech' ELSE 'active status' END;
    RAISE EXCEPTION 'Technician % already has that %', v_name, v_target
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_existing
    FROM public.technician_change_requests
   WHERE technician_id = p_technician_id
     AND change_type   = p_change_type
     AND status        = 'pending';

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'A % change for this technician is already awaiting approval',
      CASE WHEN p_change_type = 'set_good_tech' THEN 'Good Tech' ELSE 'active status' END
      USING ERRCODE = '23505',
            HINT = 'Withdraw the existing request first.';
  END IF;

  SELECT COALESCE(full_name, email) INTO v_profile FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.technician_change_requests (
    technician_id, technician_name, change_type, requested_value,
    previous_value, reason, requested_by, requested_by_name
  )
  VALUES (
    p_technician_id, v_name, p_change_type, p_requested_value,
    v_current, left(coalesce(p_reason, ''), 500), v_uid, v_profile
  )
  RETURNING id INTO v_existing;

  RETURN v_existing;
END;
$fn$;

COMMENT ON FUNCTION public.request_technician_change(uuid, text, boolean, text) IS
  'Raises a pending request for an admin to approve. Validates the current '
  'value server-side and refuses a duplicate pending request.';


-- -----------------------------------------------------------------------------
-- 5. Admin approves or declines
--    On approval the change is applied here, in the same transaction, so the
--    queue and the technician row cannot disagree.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_technician_change(
  p_request_id uuid,
  p_approve    boolean,
  p_note       text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_req     record;
  v_name    text;
  v_label   text;
  v_applied integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an admin may review technician change requests'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req
    FROM public.technician_change_requests
   WHERE id = p_request_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already %', v_req.status USING ERRCODE = '22023';
  END IF;

  v_label := CASE WHEN v_req.change_type = 'set_good_tech' THEN 'Good Tech' ELSE 'active status' END;

  IF p_approve THEN
    IF v_req.change_type = 'set_good_tech' THEN
      UPDATE public.technicians
         SET is_good_tech = v_req.requested_value
       WHERE id = v_req.technician_id;
    ELSE
      UPDATE public.technicians
         SET is_active = v_req.requested_value
       WHERE id = v_req.technician_id;
    END IF;
    GET DIAGNOSTICS v_applied = ROW_COUNT;

    UPDATE public.technician_change_requests
       SET status           = 'approved',
           reviewed_by       = v_uid,
           reviewed_by_name  = (SELECT COALESCE(full_name, email) FROM public.profiles WHERE id = v_uid),
           reviewed_at       = now(),
           review_note       = left(coalesce(p_note, ''), 500)
     WHERE id = p_request_id;

    IF v_applied = 0 THEN
      RAISE EXCEPTION 'Technician % no longer exists, so the request cannot be applied',
        v_req.technician_name USING ERRCODE = 'P0002';
    END IF;

    IF v_req.requested_by IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, title, message)
      VALUES (
        v_req.requested_by,
        format('[Approved] Technician %s change: %s', v_label, v_req.technician_name),
        format(
          'Your request to set %s to %s for %s was approved by an admin.%s',
          v_label,
          CASE WHEN v_req.requested_value THEN 'Yes' ELSE 'No' END,
          v_req.technician_name,
          CASE WHEN coalesce(p_note, '') <> ''
               THEN format(' Note: %s', p_note) ELSE '' END
        )
      );
    END IF;

    RETURN format('Approved. %s for %s is now %s.', v_label, v_req.technician_name,
                  CASE WHEN v_req.requested_value THEN 'Yes' ELSE 'No' END);
  END IF;

  UPDATE public.technician_change_requests
     SET status          = 'declined',
         reviewed_by      = v_uid,
         reviewed_by_name = (SELECT COALESCE(full_name, email) FROM public.profiles WHERE id = v_uid),
         reviewed_at      = now(),
         review_note      = left(coalesce(p_note, ''), 500)
   WHERE id = p_request_id;

  IF v_req.requested_by IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, message)
    VALUES (
      v_req.requested_by,
format('[Rejected] Technician %s change: %s', v_label, v_req.technician_name),
        format(
          'Your request to set %s to %s for %s was declined by an admin.%s',
        v_label,
        CASE WHEN v_req.requested_value THEN 'Yes' ELSE 'No' END,
        v_req.technician_name,
        CASE WHEN coalesce(p_note, '') <> ''
             THEN format(' Reason: %s', p_note) ELSE '' END
      )
    );
  END IF;

  RETURN format('Declined. %s for %s was left unchanged.', v_label, v_req.technician_name);
END;
$fn$;

COMMENT ON FUNCTION public.review_technician_change(uuid, boolean, text) IS
  'Admin approves or declines a technician change request. Approval applies the '
  'change in the same transaction and notifies the requester either way.';


-- -----------------------------------------------------------------------------
-- 6. Read the queue, and read what is pending per technician
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_technician_change_requests(
  p_status text DEFAULT 'pending'
)
RETURNS TABLE (
  id                uuid,
  technician_id     uuid,
  technician_name   text,
  change_type       text,
  requested_value   boolean,
  previous_value    boolean,
  reason            text,
  requested_by      uuid,
  requested_by_name text,
  status            text,
  reviewed_by_name  text,
  reviewed_at       timestamptz,
  review_note       text,
  created_at        timestamptz,
  -- Live technician values, so an admin reviewing a stale queue can see
  -- whether the flag already matches the request.
  current_is_good_tech boolean,
  current_is_active    boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT r.id, r.technician_id, r.technician_name, r.change_type,
         r.requested_value, r.previous_value, r.reason,
         r.requested_by, r.requested_by_name, r.status,
         r.reviewed_by_name, r.reviewed_at, r.review_note, r.created_at,
         t.is_good_tech, t.is_active
    FROM public.technician_change_requests r
    LEFT JOIN public.technicians t ON t.id = r.technician_id
   WHERE r.status = coalesce(p_status, 'pending')
   ORDER BY r.created_at;
$fn$;


CREATE OR REPLACE FUNCTION public.pending_technician_change_summary()
RETURNS TABLE (technician_id uuid, technician_name text, change_types text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT technician_id,
         min(technician_name),
         array_agg(change_type ORDER BY change_type)
    FROM public.technician_change_requests
   WHERE status = 'pending'
   GROUP BY technician_id;
$fn$;


-- -----------------------------------------------------------------------------
-- 7. Withdraw, so a processor is not blocked by their own stale request
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.withdraw_technician_change(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_req record;
BEGIN
  SELECT * INTO v_req FROM public.technician_change_requests WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already %', v_req.status USING ERRCODE = '22023';
  END IF;

  IF v_req.requested_by <> v_uid AND NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only the requester or an admin may withdraw this request'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.technician_change_requests WHERE id = p_request_id;
END;
$fn$;


-- -----------------------------------------------------------------------------
-- 8. RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.technician_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Processors raise technician change requests" ON public.technician_change_requests;
CREATE POLICY "Processors raise technician change requests"
  ON public.technician_change_requests
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'processor'::app_role)
    AND requested_by = auth.uid()
  );

-- Readable by processors and admins so the Technicians page can show who is
-- waiting. Customer service has no interest in it and is excluded.
DROP POLICY IF EXISTS "Reviewers read technician change requests" ON public.technician_change_requests;
CREATE POLICY "Reviewers read technician change requests"
  ON public.technician_change_requests
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'processor'::app_role)
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );

DROP POLICY IF EXISTS "Admins update technician change requests" ON public.technician_change_requests;
CREATE POLICY "Admins update technician change requests"
  ON public.technician_change_requests
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Requester or admin deletes technician change requests" ON public.technician_change_requests;
CREATE POLICY "Requester or admin deletes technician change requests"
  ON public.technician_change_requests
  FOR DELETE
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR requested_by = auth.uid()
  );


-- -----------------------------------------------------------------------------
-- 9. Realtime, so the admin queue updates without a refresh
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'technician_change_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.technician_change_requests;
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 10. Grants
--     Revoke from PUBLIC FIRST. These are SECURITY DEFINER and the policies on
--     this table would otherwise be bypassable by an unauthenticated caller.
-- -----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.technician_change_requests FROM anon;
GRANT SELECT, INSERT, DELETE ON public.technician_change_requests TO authenticated;
GRANT UPDATE ON public.technician_change_requests TO authenticated;

REVOKE ALL ON FUNCTION public.request_technician_change(uuid, text, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_technician_change(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_technician_change_requests(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pending_technician_change_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.withdraw_technician_change(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.request_technician_change(uuid, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_technician_change(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_technician_change_requests(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pending_technician_change_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_technician_change(uuid) TO authenticated;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP TRIGGER IF EXISTS technicians_flags_admin_only ON public.technicians;
--   DROP FUNCTION IF EXISTS public.enforce_technician_flags_admin_only();
--   DROP TRIGGER IF EXISTS technician_change_requests_updated_at
--     ON public.technician_change_requests;
--   DROP FUNCTION IF EXISTS public.set_technician_change_request_updated_at();
--   DROP FUNCTION IF EXISTS public.request_technician_change(uuid, text, boolean, text);
--   DROP FUNCTION IF EXISTS public.review_technician_change(uuid, boolean, text);
--   DROP FUNCTION IF EXISTS public.list_technician_change_requests(text);
--   DROP FUNCTION IF EXISTS public.pending_technician_change_summary();
--   DROP FUNCTION IF EXISTS public.withdraw_technician_change(uuid);
--   DROP TABLE IF EXISTS public.technician_change_requests;
--
-- Dropping the trigger is the important line. Until it exists a processor can
-- write is_good_tech and is_active directly, which is what it does today.
-- =============================================================================