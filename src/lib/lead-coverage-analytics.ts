import { eachDayOfInterval, eachMonthOfInterval, eachWeekOfInterval, format, isValid, parseISO, startOfMonth, startOfWeek } from "date-fns";
import type { CoverageLevel } from "@/lib/lead-coverage";

export type CoverageBucket = CoverageLevel | "unknown";
export const COVERAGE_BUCKETS: CoverageBucket[] = ["good", "normal", "bad", "unknown"];
export const COVERAGE_REPORT_LABELS: Record<CoverageBucket, string> = {
  good: "Good Coverage", normal: "Normal Coverage", bad: "Bad Coverage", unknown: "Unknown Coverage",
};
export const COVERAGE_REPORT_COLORS: Record<CoverageBucket, string> = {
  good: "#10b981", normal: "#f59e0b", bad: "#f43f5e", unknown: "#94a3b8",
};

export interface CoverageAnalyticsLead {
  id: string;
  created_at: string;
  coverage_level: string | null;
  coverage_area_label: string | null;
  city: string | null;
  state: string | null;
  number_name: string | null;
}
export type CoverageCounts = Record<CoverageBucket, number> & { total: number };
export type CoverageGroup = CoverageCounts & { key: string; label: string };

export const emptyCoverageCounts = (): CoverageCounts => ({ total: 0, good: 0, normal: 0, bad: 0, unknown: 0 });
export function coverageBucket(value: string | null): CoverageBucket {
  return value === "good" || value === "normal" || value === "bad" ? value : "unknown";
}
function cleanLabel(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}
export function coverageSource(lead: CoverageAnalyticsLead): string {
  // source_url is an intake chat link, not a marketing attribution field.
  return cleanLabel(lead.number_name) || "Unattributed phone line";
}
export function coverageArea(lead: CoverageAnalyticsLead): string {
  const stored = cleanLabel(lead.coverage_area_label);
  if (stored) return stored;
  const city = cleanLabel(lead.city);
  const state = cleanLabel(lead.state);
  if (city && state) return `${city}, ${state}`;
  if (city) return `${city} (state unknown)`;
  if (state) return `${state} (city unknown)`;
  return "Unknown area";
}
export const coverageGroupKey = (label: string): string => `label:${label.toLowerCase()}`;

export function aggregateCoverage(leads: CoverageAnalyticsLead[]) {
  const totals = emptyCoverageCounts();
  const areas = new Map<string, CoverageGroup>();
  const sources = new Map<string, CoverageGroup>();
  for (const lead of leads) {
    const bucket = coverageBucket(lead.coverage_level);
    totals.total++;
    totals[bucket]++;
    for (const [groups, label] of [[areas, coverageArea(lead)], [sources, coverageSource(lead)]] as const) {
      const key = coverageGroupKey(label);
      const group = groups.get(key) ?? { key, label, ...emptyCoverageCounts() };
      group.total++;
      group[bucket]++;
      groups.set(key, group);
    }
  }
  const sorted = (groups: Map<string, CoverageGroup>) => [...groups.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return { totals, areas: sorted(areas), sources: sorted(sources) };
}

export function filterCoverageLeads(leads: CoverageAnalyticsLead[], sourceKey: string, areaKey: string): CoverageAnalyticsLead[] {
  return leads.filter((lead) =>
    (sourceKey === "all" || coverageGroupKey(coverageSource(lead)) === sourceKey) &&
    (areaKey === "all" || coverageGroupKey(coverageArea(lead)) === areaKey),
  );
}

/** Use local calendar buckets consistently with Analytics' local date controls. */
export function coverageTrend(leads: CoverageAnalyticsLead[], startMs: number, endMs: number) {
  const durationDays = (endMs - startMs) / 86_400_000;
  const granularity = durationDays <= 31 ? "day" : durationDays <= 120 ? "week" : "month";
  const grouped = new Map<string, CoverageCounts & { date: string }>();
  for (const lead of leads) {
    const date = parseISO(lead.created_at);
    if (!isValid(date)) continue;
    const bucketDate = granularity === "month" ? startOfMonth(date) : granularity === "week" ? startOfWeek(date, { weekStartsOn: 1 }) : date;
    const key = format(bucketDate, "yyyy-MM-dd");
    const group = grouped.get(key) ?? { date: key, ...emptyCoverageCounts() };
    group.total++;
    group[coverageBucket(lead.coverage_level)]++;
    grouped.set(key, group);
  }
  const points = [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return { granularity, points };
  // Include zero-intake buckets rather than compressing quiet days out of the
  // chart. All-time starts at the earliest lead instead of January 1970.
  const interval = { start: startMs === 0 ? parseISO(points[0].date) : new Date(startMs), end: new Date(endMs) };
  const dates = granularity === "day" ? eachDayOfInterval(interval)
    : granularity === "week" ? eachWeekOfInterval(interval, { weekStartsOn: 1 }) : eachMonthOfInterval(interval);
  return { granularity, points: dates.map((date) => {
    const key = format(date, "yyyy-MM-dd");
    return grouped.get(key) ?? { date: key, ...emptyCoverageCounts() };
  }) };
}
