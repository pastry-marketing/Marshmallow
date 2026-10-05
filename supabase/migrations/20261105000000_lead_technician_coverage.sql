-- =============================================================================
-- Migration : 20261105000000_lead_technician_coverage.sql
-- Purpose   : Show how many active technicians are near a lead's job address,
--             as a small Good / Normal / Bad Coverage badge on the lead.
--
-- -----------------------------------------------------------------------------
-- WHAT IT ANSWERS
--
--   "How many technicians can actually reach this job?" A lead in an area with
--   nobody available is a job that will stall, and today nothing on the lead
--   says so until the job is already late.
--
--     10 or more active technicians   good    "Good Coverage"
--      1 to 9                        normal  "Normal Coverage"
--      0                             bad     "Bad Coverage"
--     no resolvable address          null    no badge at all
--
-- -----------------------------------------------------------------------------
-- DEPENDENCY
--
--   Requires public.parse_lead_location(text,text,text,text), added by
--   20261030140000_optimized_areas_and_area_performance.sql. That migration's
--   header calls the parser the single definition of where a lead is, precisely
--   so the approval screen, the technician report and the area list cannot
--   disagree. Writing a second parser here would defeat that, so this calls the
--   same one and refuses to install without it rather than silently guessing a
--   different place.
--
-- -----------------------------------------------------------------------------
-- WHY THESE ARE COLUMNS ON leads AND NOT cs_tag
--
--   cs_tag is a workflow tag: ready_to_schedule, booked, waiting_schedule_confirmation.
--   It is assigned by a person, and every status change clears it, so it is the
--   wrong home for anything derived. Reusing it would also mean the badge
--   disappears the moment someone changes a status, which is precisely when the
--   office still needs to know the area is thin.
--
--   So coverage is stored separately and is only ever written by the function
--   below. Nothing a user does clears it by accident.
--
-- -----------------------------------------------------------------------------
-- HOW "IN THAT AREA" IS DECIDED - and why it is two rules, not one
--
--   1. RADIUS, when the lead and the technicians have coordinates.
--      Technicians are geocoded when their Area is saved, and leads are
--      geocoded on the flows that need a map pin. Within 40 miles is the same
--      rule the Map View coverage circles already draw, and the same haversine
--      formula src/lib/lead-proximity.ts uses, so the badge and the map cannot
--      disagree about what is nearby.
--
--   2. CITY + STATE TEXT, when the lead has no coordinates.
--      Most historical leads have address but no latitude/longitude, so the
--      radius has nothing to measure from. The fallback compares the lead's
--      resolved city and state against the technician's free-text Area.
--
--      This is a heuristic and it is documented as one. technicians.area is
--      typed free text through a combobox, so "Dallas, TX" matches a lead in
--      Dallas, while "DFW" or "Dallas-Fort Worth" will not, and such a
--      technician is missed. That is the accepted cost of covering the old rows
--      without paying to geocode thousands of leads. Where coordinates exist the
--      radius rule takes over and the shorthand problem disappears, which is why
--      geocoding a lead improves its own badge.
--
--   KNOWN LIMITATION: a technician whose Area is a metro shorthand ("DFW") is
--   undercounted for any lead without coordinates. Reported rather than papered
--   over, because the alternative is guessing a distance from a string.
--
-- -----------------------------------------------------------------------------
-- WHY THE COUNT NEVER REVEALS A TECHNICIAN
--
--   technicians row level security allows only admin and processor to SELECT it.
--   A CS member cannot read that table, and this feature must show them a count,
--   so the computation runs in a SECURITY DEFINER function that returns a single
--   number. No name, phone number, or area is ever returned to the client, and
--   the function is not granted to authenticated at all - it is internal, and the
--   only thing the browser reads is the number stored on their own lead.
--
--   Distinct is on the lowercased name rather than the id, because the roster
--   contains duplicated names and counting rows would inflate a thin area into a
--   healthy one. That matches how area_performance() already counts.
--
-- -----------------------------------------------------------------------------
-- WHEN IT RECALCULATES
--
--   A trigger on leads fires whenever the address columns change, on insert and
--   on update. That is what makes the three cases the office asked for work
--   without anyone pressing anything:
--
--     lead created with no address   -> no resolvable location -> no badge
--     address filled in later        -> trigger fires -> badge appears
--     address edited again           -> trigger fires -> badge re-checked
--
--   The trigger lists the address columns explicitly, so its own write of the
--   coverage columns cannot re-enter it.
--
--   Editing a technician's Area changes coverage for every lead near them, which
--   no per-lead trigger can see. That is recalculate_lead_coverage() and
--   recalculate_all_lead_coverage(), both role-gated. Run the "all" version after
--   a roster change; it is the one operation that has to be asked for.
--
-- -----------------------------------------------------------------------------
-- PERMISSIONS
--
--   Internal functions revoked from PUBLIC, anon and authenticated. The two
--   recalculate entry points are granted to authenticated but authorise the
--   caller themselves, because SECURITY DEFINER and the function owner both
--   bypass row level security. search_path is pinned on every one.
--
-- ROLLBACK
--   See the bottom of this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Refuse to install without the shared location parser
--    Failing here with a named cause is better than installing a version that
--    quietly resolves a different place than the Optimisation page does.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.parse_lead_location(text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION
      'public.parse_lead_location(text,text,text,text) is missing. Apply % first.',
      '20261030140000_optimized_areas_and_area_performance.sql'
      USING ERRCODE = 'undefined_function';
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 1. The stored result
-- -----------------------------------------------------------------------------
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS coverage_tech_count integer,
  ADD COLUMN IF NOT EXISTS coverage_level text,
  ADD COLUMN IF NOT EXISTS coverage_area_label text,
  ADD COLUMN IF NOT EXISTS coverage_checked_at timestamptz;

COMMENT ON COLUMN public.leads.coverage_level IS
  'good when 10+ active technicians are near the job, normal for 1-9, bad for 0, '
  'and null when the address cannot be resolved. Derived only; never user set.';
COMMENT ON COLUMN public.leads.coverage_tech_count IS
  'Active technicians counted for this lead''s area when it was last checked.';
COMMENT ON COLUMN public.leads.coverage_area_label IS
  'The place the count was measured against, e.g. "Dallas, TX".';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_coverage_level_check'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_coverage_level_check
      CHECK (coverage_level IS NULL OR coverage_level IN ('good', 'normal', 'bad'));
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 2. The count
--    Pure computation. Returns nothing when the location cannot be resolved, so
--    an unresolvable address is never reported as zero technicians, which would
--    read as "nobody covers this" and be wrong.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_technician_coverage(_lead_id uuid)
RETURNS TABLE (tech_count bigint, area_label text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_lead          public.leads%ROWTYPE;
  v_lat           double precision;
  v_lng           double precision;
  v_city          text;
  v_state         text;
  v_zip           text;
  v_label         text;
  v_count         bigint := 0;
  v_radius_miles  constant double precision := 40;
BEGIN
  SELECT * INTO c_lead FROM public.leads l WHERE l.id = _lead_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_lat := c_lead.latitude;
  v_lng := c_lead.longitude;

  -- The same parser every area report uses.
  SELECT loc.city, loc.state, loc.zip_code
    INTO v_city, v_state, v_zip
    FROM public.parse_lead_location(
      c_lead.address, c_lead.city, c_lead.state, c_lead.zip_code
    ) AS loc;

  IF v_city IS NULL AND v_state IS NULL AND v_zip IS NULL THEN
    RETURN;
  END IF;

  v_label := COALESCE(
    NULLIF(btrim(concat_ws(', ', v_city, v_state)), ''),
    NULLIF(btrim(concat_ws(' ', v_state, v_zip)), ''),
    v_zip,
    v_city,
    v_state
  );

  -- Rule 1: radius, when the lead can be placed. -1 marks "not attempted".
  IF v_lat IS NOT NULL AND v_lng IS NOT NULL THEN
    SELECT count(DISTINCT lower(btrim(t.name)))
      INTO v_count
      FROM public.technicians t
     WHERE coalesce(t.is_active, true)
       AND t.latitude IS NOT NULL
       AND t.longitude IS NOT NULL
       AND 3958.8 * 2 * asin(least(1.0, sqrt(
              power(sin(radians(t.latitude - v_lat) / 2), 2)
            + cos(radians(v_lat)) * cos(radians(t.latitude))
            * power(sin(radians(t.longitude - v_lng) / 2), 2)
          ))) <= v_radius_miles;
  ELSE
    v_count := -1;
  END IF;

  -- Rule 2, or rule 1 when it placed nobody. A lead can sit inside a metro that
  -- the roster has no geocoded technician for, and reporting Bad on geometry
  -- alone would be misleading.
  IF v_count <= 0 THEN
    SELECT count(DISTINCT lower(btrim(t.name)))
      INTO v_count
      FROM public.technicians t
     WHERE coalesce(t.is_active, true)
       AND btrim(coalesce(t.area, '')) <> ''
       AND (v_city IS NULL OR t.area ILIKE '%' || v_city || '%')
       AND (v_state IS NULL OR t.area ILIKE '%' || v_state || '%');
  END IF;

  RETURN QUERY SELECT GREATEST(v_count, 0), v_label;
END;
$fn$;

COMMENT ON FUNCTION public.lead_technician_coverage(uuid) IS
  'Active technicians near a lead: within 40 miles when the lead has coordinates, '
  'otherwise by city and state against the technician Area text. Returns no row '
  'when the address cannot be resolved. Internal: not granted to any client role.';

REVOKE ALL ON FUNCTION public.lead_technician_coverage(uuid) FROM PUBLIC, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. Store the result on the lead
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_lead_coverage(_lead_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO v_result FROM public.lead_technician_coverage(_lead_id);

  IF v_result IS NULL THEN
    -- No resolvable location. Clear rather than leave a stale badge from a
    -- previous address, so an emptied address never keeps claiming coverage.
    UPDATE public.leads
       SET coverage_tech_count  = NULL,
           coverage_level      = NULL,
           coverage_area_label = NULL,
           coverage_checked_at = now()
     WHERE id = _lead_id
       AND (coverage_tech_count IS NOT NULL
            OR coverage_level IS NOT NULL
            OR coverage_area_label IS NOT NULL);
    RETURN;
  END IF;

  UPDATE public.leads
     SET coverage_tech_count  = v_result.tech_count::integer,
         coverage_level      = CASE
                                 WHEN v_result.tech_count >= 10 THEN 'good'
                                 WHEN v_result.tech_count >= 1  THEN 'normal'
                                 ELSE 'bad'
                               END,
         coverage_area_label = v_result.area_label,
         coverage_checked_at = now()
   WHERE id = _lead_id;
END;
$fn$;

COMMENT ON FUNCTION public.refresh_lead_coverage(uuid) IS
  'Recomputes and stores the coverage result for one lead. Internal: called by '
  'the leads trigger, not by any client role.';

REVOKE ALL ON FUNCTION public.refresh_lead_coverage(uuid) FROM PUBLIC, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 4. Recalculate when the address changes
--    The column list is what stops this looping: the write in section 3 touches
--    only coverage columns, so this trigger never sees its own effect.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_lead_coverage_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM public.refresh_lead_coverage(NEW.id);
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS leads_refresh_coverage ON public.leads;

CREATE TRIGGER leads_refresh_coverage
  AFTER INSERT OR UPDATE OF address, city, state, zip_code, latitude, longitude
  ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_lead_coverage_refresh();


-- -----------------------------------------------------------------------------
-- 5. Manual re-check, one lead
--    Granted to authenticated, so it authorises the caller itself. Same test the
--    urgent verification RPC uses, because the same reasoning applies: a definer
--    function with no internal check is safe only by accident.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalculate_lead_coverage(_lead_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_level text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT (
       public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'cs_admin'::app_role)
    OR public.has_role(v_uid, 'processor'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.id = _lead_id
         AND (l.created_by = v_uid OR l.assigned_cs = v_uid)
    )
  ) THEN
    RAISE EXCEPTION 'You cannot re-check a lead you do not have access to'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.refresh_lead_coverage(_lead_id);

  SELECT l.coverage_level INTO v_level
    FROM public.leads l
   WHERE l.id = _lead_id;

  RETURN COALESCE(v_level, 'no location');
END;
$fn$;

COMMENT ON FUNCTION public.recalculate_lead_coverage(uuid) IS
  'Recomputes one lead''s technician coverage on request. Authorises the caller '
  'internally because it is SECURITY DEFINER.';

REVOKE ALL ON FUNCTION public.recalculate_lead_coverage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_lead_coverage(uuid) TO authenticated;


-- -----------------------------------------------------------------------------
-- 6. Recompute everything, after the roster changes
--    Admin only. A technician's Area edit changes the answer for every lead near
--    them, and no per-row trigger on leads can observe that.
--
--    Deliberately a loop of separate statements rather than one CTE. A single
--    statement would share one snapshot across every part of it, so the final
--    count would read the coverage values from before the refresh rather than
--    after it, and the numbers it reports would be the old ones.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalculate_all_lead_coverage()
RETURNS TABLE (checked bigint, good bigint, normal bigint, bad bigint, unlocated bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_lead record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only an Admin may re-check coverage for every lead'
      USING ERRCODE = '42501';
  END IF;

  FOR v_lead IN
    SELECT l.id
      FROM public.leads l
     WHERE l.address IS NOT NULL OR l.city IS NOT NULL OR l.state IS NOT NULL
  LOOP
    PERFORM public.refresh_lead_coverage(v_lead.id);
  END LOOP;

  RETURN QUERY
    SELECT
      count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL),
      count(*) FILTER (WHERE l.coverage_level = 'good'),
      count(*) FILTER (WHERE l.coverage_level = 'normal'),
      count(*) FILTER (WHERE l.coverage_level = 'bad'),
      count(*) FILTER (WHERE l.coverage_checked_at IS NOT NULL AND l.coverage_level IS NULL)
    FROM public.leads l;
END;
$fn$;

COMMENT ON FUNCTION public.recalculate_all_lead_coverage() IS
  'Recomputes coverage on every located lead and returns the resulting spread. '
  'Admin only. Run after technicians are added, moved, or deactivated.';

REVOKE ALL ON FUNCTION public.recalculate_all_lead_coverage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_all_lead_coverage() TO authenticated;


-- -----------------------------------------------------------------------------
-- 7. Backfill the existing leads
--    Per lead, in its own statement, for the same snapshot reason as section 6.
--    Only the coverage columns are written, so this cannot re-enter the trigger
--    in section 4, and no address, status, schedule or note is touched.
--
--    Leads with no address at all are left alone rather than stamped Bad. They
--    will be picked up by the trigger the moment an address is filled in.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_lead record;
  v_rows integer := 0;
BEGIN
  FOR v_lead IN
    SELECT l.id
      FROM public.leads l
     WHERE (l.address IS NOT NULL OR l.city IS NOT NULL OR l.state IS NOT NULL)
       AND l.coverage_checked_at IS NULL
  LOOP
    PERFORM public.refresh_lead_coverage(v_lead.id);
    v_rows := v_rows + 1;
  END LOOP;

  RAISE NOTICE 'Lead technician coverage backfilled for % leads.', v_rows;
END $$;


-- =============================================================================
-- ROLLBACK - run manually to undo this migration.
--
--   DROP TRIGGER IF EXISTS leads_refresh_coverage ON public.leads;
--   DROP FUNCTION IF EXISTS public.trg_lead_coverage_refresh();
--   DROP FUNCTION IF EXISTS public.recalculate_all_lead_coverage();
--   DROP FUNCTION IF EXISTS public.recalculate_lead_coverage(uuid);
--   DROP FUNCTION IF EXISTS public.refresh_lead_coverage(uuid);
--   DROP FUNCTION IF EXISTS public.lead_technician_coverage(uuid);
--   ALTER TABLE public.leads
--     DROP CONSTRAINT IF EXISTS leads_coverage_level_check,
--     DROP COLUMN IF EXISTS coverage_checked_at,
--     DROP COLUMN IF EXISTS coverage_area_label,
--     DROP COLUMN IF EXISTS coverage_level,
--     DROP COLUMN IF EXISTS coverage_tech_count;
--
-- No lead's address, status, schedule or notes are modified by this migration.
-- Dropping the columns removes the badge and nothing else.
-- =============================================================================