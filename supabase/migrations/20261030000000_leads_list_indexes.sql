-- =============================================================================
-- Migration : 20261030000000_leads_list_indexes.sql
-- Purpose   : Serve the ordering used by every leads list query without a
--             post-filter sort.
--
-- CONTEXT
--   Every leads list reads the whole table ordered by (created_at DESC, id DESC):
--     src/pages/LeadsPage.tsx  -> .order("created_at", desc).order("id", desc)
--     src/pages/AllLeads.tsx   -> .order("created_at", desc).order("id", desc)
--   Both then paginate, which is why RLS decides how expensive the read is.
--
--   For a CS user the query is narrowed with eq("created_by", user_id). The
--   existing index on created_by finds the right rows, but the (created_at DESC,
--   id DESC) ordering is then applied as a separate sort step. The composite
--   index below lets Postgres satisfy the filter AND the ordering from one index
--   scan.
--
--   RLS also tests assigned_cs = auth.uid(), so a lead shared with the user is
--   matched through that column rather than created_by. It gets the same
--   treatment.
--
--   For admin / processor / opr / opr_admin the policy is effectively "all
--   rows", so the leading column is not selective and this index mostly serves
--   the stable tie-break on id. That is intentional: the (created_at DESC, id
--   DESC) order is what keeps deep pagination deterministic.
--
-- WHY NOT CONCURRENTLY
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and the
--   Supabase SQL editor may wrap a pasted file in one. The table is small
--   (~3.9k rows, ~5 MB heap), so a plain CREATE INDEX takes single-digit
--   milliseconds of ShareLock and does not need the concurrent variant. If this
--   table ever grows past roughly 100k rows, switch to CONCURRENTLY and run the
--   statements outside a transaction.
--
-- ROLLBACK - run this block verbatim to undo everything below it.
-- -----------------------------------------------------------------------------
/*
DROP INDEX IF EXISTS public.idx_leads_created_at_id_desc;
DROP INDEX IF EXISTS public.idx_leads_created_by_created_at_id_desc;
DROP INDEX IF EXISTS public.idx_leads_assigned_cs_created_at_id_desc;
ANALYZE public.leads;
*/
-- =============================================================================


-- Leading column is the sort, id is the deterministic tie-break.
-- Mirrors the existing btree on created_at, so this supersedes it.
CREATE INDEX IF NOT EXISTS idx_leads_created_at_id_desc
  ON public.leads (created_at DESC, id DESC);

-- CS "leads I created" path: filter by author, order by recency.
CREATE INDEX IF NOT EXISTS idx_leads_created_by_created_at_id_desc
  ON public.leads (created_by, created_at DESC, id DESC);

-- RLS also matches assigned_cs for leads shared with the user.
CREATE INDEX IF NOT EXISTS idx_leads_assigned_cs_created_at_id_desc
  ON public.leads (assigned_cs, created_at DESC, id DESC);

-- Refresh planner statistics so the planner costs the new indexes correctly
-- instead of falling back to the old pre-change estimates.
ANALYZE public.leads;

-- Notes on the nullable columns, checked against the live table before writing
-- this migration (3857 rows):
--   created_at  - 0 NULLs. This matters because Postgres defaults DESC ordering
--                 to NULLS FIRST, and a btree on (created_at DESC) uses the same
--                 default, so the index still satisfies the ORDER BY. If a lead
--                 ever lands with a NULL created_at it would sort to the top.
--   created_by  - 10 NULLs (leads whose creator was deleted). Leading column of
--                 the second index, which defaults to ASC NULLS LAST, so those
--                 rows sit at the end of their author's range.
--   assigned_cs - 2340 NULLs (most leads are unassigned). Expected; the index
--                 only serves the assigned subset that the RLS policy matches.
