-- Track WHEN a lead became urgent, so the Urgent Job list can be ordered by the
-- moment a lead was flipped to urgent_job — not by when the lead was created.
--
-- Before this, urgent leads tied on rank and fell back to created_at, so an old
-- lead newly marked urgent sank below recently-created urgent leads. With
-- urgent_at, any lead flipped to urgent_job (old or new) rises to the top like a
-- fresh urgent lead. Pinning and tag ordering are unaffected.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS urgent_at timestamptz;

-- Seed existing urgent leads with a best-effort "became urgent" time so the
-- ordering is sensible immediately, newest-touched first.
UPDATE public.leads
   SET urgent_at = COALESCE(last_edited_at, updated_at, created_at)
 WHERE status = 'urgent_job'
   AND urgent_at IS NULL;

-- Stamp urgent_at the moment a lead enters urgent_job (on insert or on a status
-- transition into it). Later edits to an already-urgent lead leave it untouched,
-- so the lead keeps its place unless it is flipped out of and back into urgent.
CREATE OR REPLACE FUNCTION public.set_lead_urgent_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'urgent_job'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'urgent_job') THEN
    NEW.urgent_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_lead_urgent_at ON public.leads;

CREATE TRIGGER trg_set_lead_urgent_at
BEFORE INSERT OR UPDATE ON public.leads
FOR EACH ROW
EXECUTE FUNCTION public.set_lead_urgent_at();
