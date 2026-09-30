-- =============================================================================
-- Migration : 20261030010000_fix_tech_quick_chat_rls.sql
-- Purpose   : Let a user granted `tech_quick_chat` actually use Quick Chat.
--
-- THE BUG
--   There are two navigation keys for the same feature:
--     quick_chat       - Customer Service / CS Admin
--     tech_quick_chat  - Technicians, OPR and OPR Admin
--
--   The UI gates on whichever key the user was granted - LeadDetailPage.tsx uses
--   canAccess("tech_quick_chat"). But the RLS guard on quo_outbound_messages
--   called can_use_quick_chat(_user_id), which looked at `quick_chat` only:
--
--     AND np.nav_section = 'quick_chat'
--
--   So a technician granted tech_quick_chat sees the button, types a message,
--   and the INSERT into quo_outbound_messages is refused by RLS. The failure is
--   silent: the queued-message read policy returns nothing, so there is no error
--   and no queued message. Quick Chat simply never sends.
--
--   Live at the time of writing: 6 users hold quick_chat, 2 hold
--   tech_quick_chat, and those 2 are the ones blocked.
--
-- THE FIX
--   Accept either key. Deliberately keeps the existing single-argument
--   signature so the three quo_outbound_messages policies need no change and
--   there is no window where a policy references a function that does not
--   exist.
--
--   Both keys grant the same underlying capability - queueing an outbound
--   message for the CRM extension to send - so treating them as equivalent here
--   is correct. It is not a privilege escalation: a user must still be granted
--   one of the two keys explicitly by an Admin, or be an Admin.
--
-- -----------------------------------------------------------------------------
-- ROLLBACK - run this block verbatim to undo everything below it.
-- -----------------------------------------------------------------------------
/*
CREATE OR REPLACE FUNCTION public.can_use_quick_chat(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = 'public'
AS $function$
  SELECT public.has_role(_user_id, 'admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.navigation_permissions np
      WHERE np.user_id = _user_id
        AND np.nav_section = 'quick_chat'
        AND np.allowed IS TRUE
    );
$function$;
*/
-- =============================================================================


CREATE OR REPLACE FUNCTION public.can_use_quick_chat(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $function$
  SELECT public.has_role(_user_id, 'admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.navigation_permissions np
      WHERE np.user_id = _user_id
        AND np.nav_section IN ('quick_chat', 'tech_quick_chat')
        AND np.allowed IS TRUE
    );
$function$;

-- Refresh the planner's function statistics so the policy cost estimate for
-- quo_outbound_messages reflects the new body.
ANALYZE public.navigation_permissions;
