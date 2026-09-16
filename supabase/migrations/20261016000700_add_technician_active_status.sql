-- Existing technicians remain available until someone turns them off.
ALTER TABLE public.technicians
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS technicians_active_name_idx
  ON public.technicians (is_active DESC, name ASC, id ASC);

-- Keep search pagination in the same order as the directory: active first.
CREATE OR REPLACE FUNCTION public.search_technicians(_q text, _limit int, _offset int)
RETURNS TABLE(id uuid, name text, area text, service text, notes text, chat_link text, phone_number text, latitude double precision, longitude double precision, total_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      NULLIF(trim(coalesce(_q, '')), '') AS raw,
      regexp_replace(coalesce(_q, ''), '\D', '', 'g') AS digits
  ),
  matched AS (
    SELECT t.*
    FROM public.technicians t, q
    WHERE q.raw IS NULL
       OR t.name ILIKE '%' || q.raw || '%'
       OR coalesce(t.service, '') ILIKE '%' || q.raw || '%'
       OR coalesce(t.area, '') ILIKE '%' || q.raw || '%'
       OR coalesce(t.notes, '') ILIKE '%' || q.raw || '%'
       OR coalesce(t.chat_link, '') ILIKE '%' || q.raw || '%'
       OR coalesce(t.phone_number, '') ILIKE '%' || q.raw || '%'
       OR (length(q.digits) >= 3
         AND regexp_replace(coalesce(t.phone_number, ''), '\D', '', 'g') ILIKE '%' || q.digits || '%')
  ),
  counted AS (SELECT count(*)::bigint AS c FROM matched)
  SELECT m.id, m.name, m.area, m.service, m.notes, m.chat_link,
    m.phone_number, m.latitude, m.longitude, counted.c AS total_count
  FROM matched m, counted
  ORDER BY m.is_active DESC, m.name ASC, m.id ASC
  LIMIT GREATEST(_limit, 0)
  OFFSET GREATEST(_offset, 0);
$$;
