import { describe, expect, it } from "vitest";

import { buildTechnicianNameCounts, sharedNameCount } from "./technician-names";

describe("buildTechnicianNameCounts", () => {
  it("counts technicians per name, ignoring case and padding", () => {
    const counts = buildTechnicianNameCounts([
      { name: "Aaron" },
      { name: " aaron " },
      { name: "Abdul" },
    ]);
    expect(sharedNameCount(counts, "Aaron")).toBe(2);
    expect(sharedNameCount(counts, "Abdul")).toBe(1);
  });

  it("ignores blank and missing names instead of merging them together", () => {
    const counts = buildTechnicianNameCounts([{ name: "" }, { name: "   " }, { name: null }, { name: undefined }]);
    expect(counts.size).toBe(0);
    expect(sharedNameCount(counts, "")).toBe(0);
  });
});

describe("sharedNameCount", () => {
  it("returns 0 when no counts were supplied", () => {
    expect(sharedNameCount(undefined, "Aaron")).toBe(0);
  });

  it("returns 0 for an absent name", () => {
    const counts = buildTechnicianNameCounts([{ name: "Aaron" }, { name: "Aaron" }]);
    expect(sharedNameCount(counts, "")).toBe(0);
    expect(sharedNameCount(counts, null)).toBe(0);
    expect(sharedNameCount(counts, "  ")).toBe(0);
  });

  it("reports 0 for a name no technician has", () => {
    const counts = buildTechnicianNameCounts([{ name: "Aaron" }]);
    expect(sharedNameCount(counts, "Zed")).toBe(0);
  });
});