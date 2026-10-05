import { describe, expect, it } from "vitest";
import {
  COVERAGE_LABEL,
  GOOD_COVERAGE_MIN,
  coverageLevelFor,
  coverageTitle,
  hasCoverage,
} from "./lead-coverage";

describe("coverageLevelFor", () => {
  // These thresholds are also a CASE expression in refresh_lead_coverage(). If
  // the two ever disagree, a lead would be badged one way and counted another,
  // which is worse than having no badge, so they are pinned here.
  it("calls 10 or more good", () => {
    expect(GOOD_COVERAGE_MIN).toBe(10);
    expect(coverageLevelFor(10)).toBe("good");
    expect(coverageLevelFor(11)).toBe("good");
    expect(coverageLevelFor(500)).toBe("good");
  });

  it("calls 1 to 9 normal", () => {
    for (const count of [1, 2, 5, 8, 9]) {
      expect(coverageLevelFor(count)).toBe("normal");
    }
  });

  it("calls 0 bad", () => {
    expect(coverageLevelFor(0)).toBe("bad");
  });

  // No address, no badge. Reporting an unresolved address as Bad would claim
  // "nobody covers this" about a place the system never located.
  it("reports nothing when there is no count", () => {
    expect(coverageLevelFor(null)).toBeNull();
    expect(coverageLevelFor(undefined)).toBeNull();
  });
});

describe("hasCoverage", () => {
  it("is true only for a stored level", () => {
    expect(hasCoverage({ coverage_level: "good" })).toBe(true);
    expect(hasCoverage({ coverage_level: "normal" })).toBe(true);
    expect(hasCoverage({ coverage_level: "bad" })).toBe(true);
  });

  it("is false for an unresolved or absent address", () => {
    expect(hasCoverage({ coverage_level: null })).toBe(false);
    expect(hasCoverage({})).toBe(false);
    expect(hasCoverage(null)).toBe(false);
    expect(hasCoverage(undefined)).toBe(false);
  });

  // An unexpected value must not be rendered as a level. A stale or renamed
  // column should leave the lead unbadged rather than show a colour that means
  // nothing.
  it("is false for an unrecognised level", () => {
    expect(hasCoverage({ coverage_level: "excellent" })).toBe(false);
    expect(hasCoverage({ coverage_level: "" })).toBe(false);
  });
});

describe("COVERAGE_LABEL", () => {
  it("reads the way the office describes it", () => {
    expect(COVERAGE_LABEL.good).toBe("Good Coverage");
    expect(COVERAGE_LABEL.normal).toBe("Normal Coverage");
    expect(COVERAGE_LABEL.bad).toBe("Bad Coverage");
  });
});

describe("coverageTitle", () => {
  // The hover text is where the count and the place are explained, so somebody
  // looking at a red badge can tell whether the area is genuinely empty or the
  // address simply did not resolve.
  it("includes the count and the area", () => {
    expect(coverageTitle("bad", 0, "Dallas, TX")).toBe(
      "Bad Coverage · 0 active technicians near Dallas, TX",
    );
    expect(coverageTitle("good", 14, "Dallas, TX")).toBe(
      "Good Coverage · 14 active technicians near Dallas, TX",
    );
  });

  it("uses the singular for one technician", () => {
    expect(coverageTitle("normal", 1, "Austin, TX")).toContain("1 active technician near");
    expect(coverageTitle("normal", 1, "Austin, TX")).not.toContain("technicians");
  });

  it("drops the place when there is no label", () => {
    expect(coverageTitle("normal", 3, null)).toBe("Normal Coverage · 3 active technicians");
    expect(coverageTitle("normal", 3, "   ")).toBe("Normal Coverage · 3 active technicians");
  });

  it("falls back to the bare label when there is no count", () => {
    expect(coverageTitle("good", null, "Dallas, TX")).toBe("Good Coverage");
    expect(coverageTitle("good", undefined)).toBe("Good Coverage");
  });
});