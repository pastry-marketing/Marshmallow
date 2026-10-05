// =============================================================================
// Technician coverage on a lead.
//
// "How many technicians can reach this job?" A lead in a thin area will stall,
// and nothing on the card says so until the job is already late.
//
//   good    10 or more active technicians
//   normal  1 to 9
//   bad     0
//   null    the address could not be resolved, so no badge is shown at all
//
// The count is computed in the database and stored on the lead, so a list page
// reads it like any other column instead of calling once per row. Only the count
// ever reaches the browser - the technicians table is restricted to admins and
// processors, and nothing here reveals who or where.
//
// The lead and every technician are placed on the us_places table (31,839 Census
// places) and counted within 40 miles, the same rule Map View's coverage circles
// draw. A lead whose address cannot be placed shows no badge rather than a false
// "Bad Coverage", and a technician whose Area is blank, a whole state, or a
// shorthand like "DFW" counts for no lead.
//
// See supabase/migrations/20261107000000_place_coverage_by_us_places.sql, and
// supabase/tests/90_lead_coverage_us_places.sql for the cases that pin it down.
// =============================================================================

export type CoverageLevel = "good" | "normal" | "bad";

/** The number at or above which an area counts as well covered. */
export const GOOD_COVERAGE_MIN = 10;

export const COVERAGE_LABEL: Record<CoverageLevel, string> = {
  good: "Good Coverage",
  normal: "Normal Coverage",
  bad: "Bad Coverage",
};

/**
 * The level the database should have stored for a given count.
 *
 * Mirrors the CASE in refresh_lead_coverage(). Kept here so a freshly created
 * lead can be shown a badge before its first write lands, and so the thresholds
 * are asserted by tests rather than only existing in SQL.
 */
export function coverageLevelFor(count: number | null | undefined): CoverageLevel | null {
  if (count === null || count === undefined) return null;
  if (count >= GOOD_COVERAGE_MIN) return "good";
  if (count >= 1) return "normal";
  return "bad";
}

/** True when the row carries a usable coverage result worth rendering. */
export function hasCoverage(
  lead: { coverage_level?: CoverageLevel | string | null } | null | undefined,
): boolean {
  return lead?.coverage_level === "good"
    || lead?.coverage_level === "normal"
    || lead?.coverage_level === "bad";
}

/** Tailwind classes for the badge, matching the app's status colour vocabulary. */
export const COVERAGE_CLASS: Record<CoverageLevel, string> = {
  good: "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  normal: "border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300",
  bad: "border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300",
};

export const COVERAGE_DOT_CLASS: Record<CoverageLevel, string> = {
  good: "bg-emerald-500",
  normal: "bg-amber-500",
  bad: "bg-rose-500",
};

/** "Good Coverage · 14 technicians near Dallas, TX" — the hover explanation. */
export function coverageTitle(
  level: CoverageLevel,
  count: number | null | undefined,
  areaLabel?: string | null,
): string {
  const label = COVERAGE_LABEL[level];
  if (count === null || count === undefined) return label;

  const techs = `${count} active technician${count === 1 ? "" : "s"}`;
  const where = areaLabel?.trim() ? ` near ${areaLabel.trim()}` : "";
  return `${label} · ${techs}${where}`;
}