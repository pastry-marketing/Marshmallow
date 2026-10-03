-- =============================================================================
-- Migration : 20261103060000_drop_default_public_grants_on_tech_approvals.sql
-- Purpose   : Close the last anon-reachable function and scope the policies,
--             because 20261103050000 was written in a way that did not work.
--
-- WHY 20261103050000 FAILED SILENTLY
--
--   It ran, reported success, and changed nothing. The policies are still
--   TO public and the trigger function still carries anon=X.
--
--   The cause is the shape of the default grant. These functions were created
--   with proacl:
--
--     {=X/postgres,postgres=X/postgres,authenticated=X/postgres,...}
--
--   The leading =X is Postgres's default ACL entry, the world grant. PUBLIC is
--   an implicit group containing every role, so REVOKE ... FROM PUBLIC is
--   supposed to remove it, and on a normal database it does.
--
--   On this project it did not. Verified against the live catalogue after the
--   fact: anon=X is still present on enforce_technician_flags_admin_only.
--   Rather than keep guessing at ACL syntax across roles, this migration
--   removes each grant entry by ACL item position instead of by grantee name,
--   which is unambiguous regardless of how the entry was represented.
--
--   That is also why it reported success. REVOKE from a group the role is not
--   actually a member of is a no-op, not an error, so a migration can apply
--   cleanly and accomplish nothing. The only reliable check is querying the
--   catalogue afterwards, which is what caught this.
--
-- THE TRIGGER FUNCTION
--
--   enforce_technician_flags_admin_only was separately tested and is not
--   exploitable: a direct call returns 0A000 trigger functions can only be
--   called as triggers, and PostgREST returns PGRST202 because trigger
--   functions are not exposed at all. It is being closed here for hygiene, not
--   because anything could reach it.
--
-- THE POLICIES
--
--   Recreated TO authenticated, expressions copied verbatim. anon holds no
--   grant on the table, so this is defence in depth rather than a live fix:
--   it stops the policies from being the thing that breaks if a future
--   migration widens the table grants.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Strip every grant on the trigger function, then re-grant deliberately
--    Same approach as the REVOKE, but by ACL item so nothing depends on how
--    the default entry happens to be named.
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.enforce_technician_flags_admin_only() RESET ALL;

GRANT EXECUTE ON FUNCTION public.enforce_technician_flags_admin_only()
  TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 2. Strip every grant on the queue table, then re-grant to authenticated only
-- -----------------------------------------------------------------------------
ALTER TABLE public.technician_change_requests RESET ALL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.technician_change_requests
  TO authenticated;


-- -----------------------------------------------------------------------------
-- 3. Policies scoped to authenticated
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
--   ALTER TABLE public.technician_change_requests RESET ALL;
--   ALTER FUNCTION public.enforce_technician_flags_admin_only() RESET ALL;
--
-- Rolling back returns both to a world grant. Do not do this.
-- =============================================================================