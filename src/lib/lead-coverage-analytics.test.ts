import { describe, expect, it } from "vitest";
import { aggregateCoverage, coverageArea, coverageBucket, coverageGroupKey, coverageSource, coverageTrend, filterCoverageLeads, type CoverageAnalyticsLead } from "./lead-coverage-analytics";

const row = (overrides: Partial<CoverageAnalyticsLead> = {}): CoverageAnalyticsLead => ({
  id: "1", created_at: "2026-10-09T12:00:00Z", coverage_level: "good", coverage_area_label: "Dallas, TX", city: "Dallas", state: "TX", number_name: "Houston Handyman", ...overrides,
});

describe("lead coverage intake analytics", () => {
  it("keeps unknown coverage separate and reconciles every breakdown with the total", () => {
    const report = aggregateCoverage([row(), row({ id: "2", coverage_level: "normal" }), row({ id: "3", coverage_level: "bad" }), row({ id: "4", coverage_level: null }), row({ id: "5", coverage_level: "unexpected", number_name: null })]);
    expect(report.totals).toEqual({ total: 5, good: 1, normal: 1, bad: 1, unknown: 2 });
    for (const groups of [report.areas, report.sources]) {
      expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(5);
      for (const group of groups) expect(group.good + group.normal + group.bad + group.unknown).toBe(group.total);
    }
    expect(coverageBucket(null)).toBe("unknown");
  });

  it("groups phone-line names ignoring whitespace/case without inventing a marketing channel", () => {
    const report = aggregateCoverage([row(), row({ number_name: "  houston   handyman " }), row({ number_name: " " })]);
    expect(report.sources).toHaveLength(2);
    expect(report.sources[0].total).toBe(2);
    expect(coverageSource(row({ number_name: null }))).toBe("Unattributed phone line");
  });

  it("prefers resolved coverage areas, preserves state identity, and labels missing location", () => {
    expect(coverageArea(row({ city: "Other city" }))).toBe("Dallas, TX");
    expect(coverageArea(row({ coverage_area_label: null, city: "Springfield", state: "IL" }))).not.toBe(coverageArea(row({ coverage_area_label: null, city: "Springfield", state: "MO" })));
    expect(coverageArea(row({ coverage_area_label: null, city: null, state: null }))).toBe("Unknown area");
  });

  it("applies source and area filters together so every visualization uses the same population", () => {
    const leads = [row(), row({ id: "2", coverage_area_label: "Austin, TX" }), row({ id: "3", number_name: "Chicago Handyman" })];
    const filtered = filterCoverageLeads(leads, coverageGroupKey("Houston Handyman"), coverageGroupKey("Dallas, TX"));
    expect(filtered.map((lead) => lead.id)).toEqual(["1"]);
    expect(filterCoverageLeads(leads, "all", "all")).toHaveLength(3);
  });

  it("reconciles chronological trend counts with totals and changes granularity for long ranges", () => {
    const leads = [row({ created_at: "2026-10-09T12:00:00Z" }), row({ created_at: "2026-10-01T12:00:00Z", coverage_level: null })];
    const trend = coverageTrend(leads, Date.parse("2026-10-01"), Date.parse("2026-10-10"));
    expect(trend.granularity).toBe("day");
    expect(trend.points[0].date).toBe("2026-10-01");
    expect(trend.points.reduce((sum, point) => sum + point.total, 0)).toBe(2);
    expect(coverageTrend(leads, Date.parse("2026-08-01"), Date.parse("2026-10-10")).granularity).toBe("week");
    expect(coverageTrend(leads, 0, Date.parse("2026-10-10")).granularity).toBe("month");
  });

  it("handles an empty date range without division or synthetic attribution", () => {
    expect(aggregateCoverage([]).totals).toEqual({ total: 0, good: 0, normal: 0, bad: 0, unknown: 0 });
    expect(coverageTrend([], 0, Date.now()).points).toEqual([]);
  });
});
