import { describe, expect, it } from "vitest";
import {
  areaGroupKey,
  groupByArea,
  round1,
  summariseTechPerformance,
  techPerformanceToCsv,
  toCsvCell,
  type TechPerformanceRow,
} from "./tech-performance";

function row(over: Partial<TechPerformanceRow> = {}): TechPerformanceRow {
  return {
    tech_name: "Eli",
    paid_count: 0,
    cancelled_count: 0,
    scheduled_count: 0,
    paid_rate_pct: null,
    city: null,
    state: null,
    zip_code: null,
    location_label: "Unknown",
    opr_code: null,
    good_tech: false,
    last_paid_at: null,
    ...over,
  };
}

describe("summariseTechPerformance", () => {
  it("totals the columns", () => {
    const s = summariseTechPerformance([
      row({ paid_count: 30, cancelled_count: 13, scheduled_count: 78 }),
      row({ paid_count: 23, cancelled_count: 17, scheduled_count: 67 }),
    ]);
    expect(s.technicians).toBe(2);
    expect(s.paidTotal).toBe(53);
    expect(s.cancelledTotal).toBe(30);
    expect(s.scheduledTotal).toBe(145);
  });

  it("divides the paid rate by paid + cancelled, not by every lead", () => {
    const s = summariseTechPerformance([
      row({ paid_count: 30, cancelled_count: 13, scheduled_count: 78 }),
    ]);
    // 30 / 43 = 69.767... -> 69.8
    expect(s.overallPaidRate).toBe(69.8);
  });

  it("returns a null paid rate instead of dividing by zero", () => {
    const s = summariseTechPerformance([row({ scheduled_count: 5 })]);
    expect(s.overallPaidRate).toBeNull();
  });

  it("handles an empty result set", () => {
    const s = summariseTechPerformance([]);
    expect(s).toEqual({
      technicians: 0,
      paidTotal: 0,
      cancelledTotal: 0,
      scheduledTotal: 0,
      overallPaidRate: null,
      goodTechCount: 0,
      approximateLocationCount: 0,
    });
  });

  it("counts flagged Good Techs", () => {
    const s = summariseTechPerformance([
      row({ good_tech: true }),
      row({ good_tech: false }),
      row({ good_tech: true }),
    ]);
    expect(s.goodTechCount).toBe(2);
  });

  it("counts rows whose location fell back to state or zip", () => {
    const s = summariseTechPerformance([
      row({ city: "Austin", state: "TX", zip_code: "78739" }),
      row({ city: null, state: "FL", zip_code: "33312" }),
      row({ city: null, state: null, zip_code: "33312" }),
      row({ city: null, state: null, zip_code: null }),
    ]);
    expect(s.approximateLocationCount).toBe(2);
  });

  it("treats missing counts as zero rather than NaN", () => {
    const s = summariseTechPerformance([
      row({ paid_count: undefined as unknown as number }),
    ]);
    expect(s.paidTotal).toBe(0);
    expect(Number.isNaN(s.overallPaidRate)).toBe(false);
  });
});

describe("round1", () => {
  it("rounds to one decimal place", () => {
    expect(round1(69.7674)).toBe(69.8);
    expect(round1(100)).toBe(100);
    expect(round1(0)).toBe(0);
  });
});

describe("areaGroupKey", () => {
  it("prefers state plus zip", () => {
    expect(areaGroupKey(row({ state: "TX", zip_code: "78739" }))).toBe("TX 78739");
  });

  it("falls back to state alone, then zip alone", () => {
    expect(areaGroupKey(row({ state: "TX", zip_code: null }))).toBe("TX");
    expect(areaGroupKey(row({ state: null, zip_code: "78739" }))).toBe("78739");
  });

  it("returns null when nothing resolved, so the row is not grouped", () => {
    expect(areaGroupKey(row({ state: null, zip_code: null }))).toBeNull();
  });

  it("never uses the parsed city as a grouping key", () => {
    expect(areaGroupKey(row({ city: "Austin", state: "TX", zip_code: "78739" }))).toBe(
      "TX 78739",
    );
  });
});

describe("groupByArea", () => {
  it("rolls technicians up per area and computes the paid rate", () => {
    const groups = groupByArea([
      row({ tech_name: "Eli", paid_count: 30, cancelled_count: 13, state: "TX", zip_code: "78739" }),
      row({ tech_name: "Boryslav", paid_count: 10, cancelled_count: 10, state: "TX", zip_code: "78739" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "TX 78739",
      technicians: 2,
      paid: 40,
      cancelled: 23,
    });
    // 40 / 63 = 63.492... -> 63.5
    expect(groups[0].paidRate).toBe(63.5);
  });

  it("skips rows with no resolvable location", () => {
    const groups = groupByArea([
      row({ tech_name: "NoLocation", state: null, zip_code: null }),
      row({ tech_name: "Known", state: "TX", zip_code: "78739" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("TX 78739");
  });

  it("sorts by paid descending", () => {
    const groups = groupByArea([
      row({ tech_name: "Low", paid_count: 1, state: "TX", zip_code: "1" }),
      row({ tech_name: "High", paid_count: 50, state: "FL", zip_code: "2" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["FL 2", "TX 1"]);
  });

  it("gives an area with no decided work a null rate", () => {
    const groups = groupByArea([
      row({ paid_count: 0, cancelled_count: 0, scheduled_count: 9, state: "TX", zip_code: "1" }),
    ]);
    expect(groups[0].paidRate).toBeNull();
  });
});

describe("toCsvCell", () => {
  it("quotes values containing a comma", () => {
    expect(toCsvCell("Fort Lauderdale, FL")).toBe('"Fort Lauderdale, FL"');
  });

  it("doubles embedded quotes", () => {
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes newlines", () => {
    expect(toCsvCell("a\nb")).toBe('"a\nb"');
  });

  it("renders null and undefined as empty", () => {
    expect(toCsvCell(null)).toBe("");
    expect(toCsvCell(undefined)).toBe("");
  });

  it("leaves plain values untouched", () => {
    expect(toCsvCell("Austin")).toBe("Austin");
    expect(toCsvCell(42)).toBe("42");
  });
});

describe("techPerformanceToCsv", () => {
  it("emits CRLF rows with a header", () => {
    const csv = techPerformanceToCsv([
      row({ tech_name: "Eli", paid_count: 30, cancelled_count: 13, state: "TX", zip_code: "78739" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("Technician");
    expect(lines[1]).toContain("Eli");
    expect(lines[1]).toContain("30");
  });

  it("keeps a row intact when a city contains a comma", () => {
    const csv = techPerformanceToCsv([
      row({ tech_name: "X", location_label: "Fort Lauderdale, FL" }),
    ]);
    const dataLine = csv.split("\r\n")[1];
    // quoted, so the field count stays correct
    expect(dataLine).toContain('"Fort Lauderdale, FL"');
  });

  it("writes an empty cell for a missing paid rate", () => {
    const csv = techPerformanceToCsv([row({ paid_rate_pct: null })]);
    const cells = csv.split("\r\n")[1].split(",");
    expect(cells[7]).toBe("");
  });

  it("returns only a header for no rows", () => {
    expect(techPerformanceToCsv([]).split("\r\n")).toHaveLength(1);
  });
});
