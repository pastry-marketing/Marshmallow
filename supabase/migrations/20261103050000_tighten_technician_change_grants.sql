-- =============================================================================
-- Migration : 20261103050000_tighten_technician_change_grants.sql
-- Purpose   : Harden two loosenesses in the technician change feature that are
--             not currently exploitable but should not be left to chance.
--
-- 1. TRIGGER FUNCTION STILL GRANTED TO PUBLIC
--
--    enforce_technician_flags_admin_only was never revoked, so it carries the
--    default EXECUTE grant to PUBLIC from its CREATE.
--
--    Tested rather than assumed. It is not exploitable:
--
--      direct SQL   -> 0A000: trigger functions can only be called as triggers
--      via PostgREST -> PGRST202: not present in the schema cache
--
--    because NEW and OLD do not exist outside a trigger, and PostgREST does
--    not expose trigger functions at all. So this is hardening rather than a
--    fix, and it is recorded as such so nobody reads it as a live hole.
--
--    It is still revoked. A function that can only fail closed is worth
--    revoking anyway, because the next audit of the grant list should not
--    have to work out whether this one was deliberate.
--
-- 2. POLICIES CREATED TO public INSTEAD OF authenticated
--
--    CREATE POLICY without a TO clause defaults to PUBLIC. Every other policy
--    in this schema names its roles, so these four were inconsistent with the
--    house pattern as well as being wider than intended.
--
--    Not exploitable today, because the table grants are the gate and anon
--    holds none:
--
--      information_schema.role_table_grants for anon -> no rows
--
--    But the policy being TO public means the only thing standing between an
--    unauthenticated caller and this table is a table grant. If any future
--    migration grants SELECT on this table more widely, the policies would
--    already permit it. This closes that single point of failure by making the
--    policy itself refuse non-authenticated callers.
--
--    The USING and WITH CHECK expressions are unchanged, so behaviour for
--    processors and admins is identical.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Revoke the trigger function
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.enforce_technician_flags_admin_only() FROM PUBLIC, anon;

-- The trigger still fires. EXECUTE on a trigger function is checked when the
-- trigger runs, and the table owner does not need it, but granting to
-- authenticated keeps the intent explicit for a function that is part of the
-- feature's surface.
GRANT EXECUTE ON FUNCTION public.enforce_technician_flags_admin_only() TO authenticated;


-- -----------------------------------------------------------------------------
-- 2. Rebuild the policies against authenticated explicitly
--    Expressions are copied verbatim from 20261103030000.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Processors raise technician change requests" ON public.technician_change_requests;
CREATE POLICY "Processors raise technician change requests"
  ON public.technician_change_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'processor'::app_role)
    AND requested_by = auth.uid()
  );

DROP POLICY IF EXISTS "Reviewers read technician change requests" ON public.technician_change_requests;
CREATE POLICY "Reviewers read technician change requests"
  ON public.technician_change_requests
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'processor'::app_role)
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );

DROP POLICY IF EXISTS "Admins update technician change requests" ON public.technician_change_requests;
CREATE POLICY "Admins update technician change requests"
  ON public.technician_change_requests
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Requester or admin deletes technician change requests" ON public.technician_change_requests;
CREATE POLICY "Requester or admin deletes technician change requests"
  ON public.technician_change_requests
  FOR DELETE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR requested_by = auth.uid()
  );


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   REVOKE EXECUTE ON FUNCTION public.enforce_technician_flags_admin_only() FROM authenticated;
--   DROP POLICY IF EXISTS "Processors raise technician change requests" ON public.technician_change_requests;
--   CREATE POLICY "Processors raise technician change requests"
--     ON public.technician_change_requests FOR INSERT
--     WITH CHECK (public.has_role(auth.uid(), 'processor'::app_role) AND requested_by = auth.uid());
--   DROP POLICY IF EXISTS "Reviewers read technician change requests" ON public.technician_change_requests;
--   CREATE POLICY "Reviewers read technician change requests"
--     ON public.technician_change_requests FOR SELECT
--     USING (public.has_role(auth.uid(), 'processor'::app_role) OR public.has_role(auth.uid(), 'admin'::app_role));
--   DROP POLICY IF EXISTS "Admins update technician change requests" ON public.technician_change_requests;
--   CREATE POLICY "Admins update technician change requests"
--     ON public.technician_change_requests FOR UPDATE
--     USING (public.has_role(auth.uid(), 'admin'::app_role))
--     WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
--   DROP POLICY IF EXISTS "Requester or admin deletes technician change requests" ON public.technician_change_requests;
--   CREATE POLICY "Requester or admin deletes technician change requests"
--     ON public.technician_change_requests FOR DELETE
--     USING (public.has_role(auth.uid(), 'admin'::app_role) OR requested_by = auth.uid());
--
-- Rolling back returns the policies to TO public, which leaves the table
-- grants as the only thing preventing anonymous reads.
-- =============================================================================