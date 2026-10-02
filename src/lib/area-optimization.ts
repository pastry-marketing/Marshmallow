import { supabase } from "@/integrations/supabase/client";

/** A location resolved from a lead, preferring the structured columns. */
export interface ResolvedLocation {
  city: string | null;
  state: string | null;
  zip_code: string | null;
}

/** How an area has actually performed, for the evidence shown before a decision. */
export interface AreaPerformance {
  area_label: string;
  technicians: number;
  paid_count: number;
  cancelled_count: number;
  scheduled_count: number;
  closed_rate_pct: number | null;
  last_paid_at: string | null;
}

/** A state an Admin has marked as worth pushing more work into. */
export interface OptimizedArea extends AreaPerformance {
  id: string;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  label: string;
  note: string | null;
  is_active: boolean;
  marked_at: string;
}

/** The subset of a lead needed to resolve where it closed. */
export interface LeadLocationSource {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
}

/**
 * Resolves where a lead closed.
 *
 * Delegates to the database rather than re-parsing the address here. The rules
 * are subtle - country suffixes, trailing commas, trusting city only when the
 * address is comma-delimited, restricting state to real codes - and the
 * approval screen, the technician report and the area list must all agree. A
 * second implementation in TypeScript would eventually disagree with the SQL
 * and the office would see two different numbers for the same place.
 */
export async function resolveLeadLocation(
  lead: LeadLocationSource,
): Promise<ResolvedLocation> {
  const { data, error } = await supabase.rpc("parse_lead_location" as never, {
    _address: lead.address ?? null,
    _city: lead.city ?? null,
    _state: lead.state ?? null,
    _zip: lead.zip_code ?? null,
  } as never);

  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as ResolvedLocation | null;
  return {
    city: row?.city ?? null,
    state: row?.state ?? null,
    zip_code: row?.zip_code ?? null,
  };
}

/**
 * How a candidate area has performed, so "Optimise this area" is decided on
 * evidence rather than on a hunch.
 *
 * Returns null when the area cannot be identified at all, because a panel
 * showing zeros for an unknown place is worse than no panel.
 */
export async function fetchAreaPerformance(
  location: ResolvedLocation,
): Promise<AreaPerformance | null> {
  if (!location.state && !location.zip_code && !location.city) return null;

  const { data, error } = await supabase.rpc("area_performance" as never, {
    _city: location.city ?? null,
    _state: location.state ?? null,
    _zip: location.zip_code ?? null,
  } as never);

  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as AreaPerformance | null;
  return row ?? null;
}

/** A state ranked on the jobs that closed in it. */
export interface AreaLeaderboardRow {
  state: string | null;
  cities: string | null;
  technicians: number;
  closed_count: number;
  cancelled_count: number;
  scheduled_count: number;
  closed_rate_pct: number | null;
  is_optimised: boolean;
  last_closed_at: string | null;
}

/**
 * Areas ranked by the jobs that closed in them.
 *
 * State is the grain because that is where the evidence is: CA carries 92
 * closed jobs while the busiest single zip carries 3, so ranking any finer
 * would list places with one job and call it a signal.
 */
export async function fetchAreaLeaderboard(
  limit = 25,
): Promise<AreaLeaderboardRow[]> {
  const { data, error } = await supabase.rpc("area_leaderboard" as never, {
    _limit: limit,
  } as never);

  // Rethrown rather than swallowed: the message below has to name the real
  // cause. A missing function, a stale schema cache and a denied grant all
  // look identical from the page, and guessing wrong sends whoever is
  // debugging it after the wrong problem.
  if (error) {
    throw new Error(
      error.code === "PGRST202"
        ? "area_leaderboard is not known to the API yet - run the migration, then reload the schema cache."
        : `${error.code ?? "error"}: ${error.message}`,
    );
  }
  return (data as unknown as AreaLeaderboardRow[]) ?? [];
}

export async function fetchOptimizedAreas(): Promise<OptimizedArea[]> {
  const { data, error } = await supabase.rpc("optimized_areas_with_performance" as never);
  if (error) throw error;
  return (data as unknown as OptimizedArea[]) ?? [];
}

/** Human label for a location, matching the format used in the reports. */
export function formatAreaLabel(location: ResolvedLocation): string {
  const parts = [location.city, location.state].filter(Boolean).join(", ");
  if (parts) return [parts, location.zip_code].filter(Boolean).join(" ");
  return location.zip_code || location.state || location.city || "";
}

/**
 * Marks or unmarks an area.
 *
 * The unique key is the state, so marking the same state twice updates the
 * existing row rather than creating a duplicate, and Austin and Dallas are one
 * decision about Texas rather than two decisions about separate places.
 */
export async function setAreaOptimised(
  location: ResolvedLocation,
  optimised: boolean,
): Promise<void> {
  const { state, city, zip_code } = location;
  if (!state) throw new Error("Cannot optimise an area with no state");

  const label = formatAreaLabel(location);

  if (optimised) {
    const { error } = await supabase
      .from("optimized_areas" as never)
      .upsert(
        {
          state,
          city: city ?? null,
          zip_code: zip_code ?? null,
          label: label || state,
          is_active: true,
        } as never,
        { onConflict: "state" },
      );
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from("optimized_areas" as never)
    .update({ is_active: false } as never)
    .eq("state", state);
  if (error) throw error;
}

/**
 * Flags or unflags the technician on a lead as a Good Tech.
 *
 * Technicians are keyed by free-text name and 332 names are duplicated, so
 * every row sharing the name is updated. That keeps this consistent with how
 * the Technicians page already edits the same flag.
 */
export async function setGoodTechForLead(
  techName: string | null | undefined,
  goodTech: boolean,
): Promise<void> {
  const name = (techName ?? "").trim();
  if (!name) return;

  const { error } = await supabase
    .from("technicians")
    .update({ is_good_tech: goodTech } as never)
    .ilike("name", name);
  if (error) throw error;
}

/**
 * Saves a confirmed location back onto the lead.
 *
 * This is the part that makes the feature get better over time. Historical
 * city/state is empty on almost every lead, so the reports have to guess from
 * the address. Every approval that saves a confirmed value turns a guess into
 * a fact, and the reports get more trustworthy with use.
 */
export async function persistLeadLocation(
  leadId: string,
  location: ResolvedLocation,
): Promise<void> {
  const patch: Record<string, string | null> = {};
  if (location.city !== undefined) patch.city = location.city;
  if (location.state !== undefined) patch.state = location.state;
  if (location.zip_code !== undefined) patch.zip_code = location.zip_code;
  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase.from("leads").update(patch as never).eq("id", leadId);
  if (error) throw error;
}
