import { describe, expect, it } from "vitest";
import { formatAreaLabel, type ResolvedLocation } from "./area-optimization";

function loc(over: Partial<ResolvedLocation> = {}): ResolvedLocation {
  return { city: null, state: null, zip_code: null, ...over };
}

describe("formatAreaLabel", () => {
  it("matches the reports: City, ST then zip", () => {
    expect(formatAreaLabel(loc({ city: "Austin", state: "TX", zip_code: "78739" }))).toBe(
      "Austin, TX 78739",
    );
  });

  it("omits the city when only a state and zip resolved", () => {
    expect(formatAreaLabel(loc({ state: "FL", zip_code: "33312" }))).toBe("FL 33312");
  });

  it("omits the zip when only a state resolved", () => {
    expect(formatAreaLabel(loc({ state: "TX" }))).toBe("TX");
  });

  it("falls back to the zip alone", () => {
    expect(formatAreaLabel(loc({ zip_code: "78739" }))).toBe("78739");
  });

  it("falls back to the city alone", () => {
    expect(formatAreaLabel(loc({ city: "Austin" }))).toBe("Austin");
  });

  it("returns an empty string when nothing resolved, rather than a placeholder", () => {
    expect(formatAreaLabel(loc())).toBe("");
  });

  it("does not leave a leading or trailing separator", () => {
    const label = formatAreaLabel(loc({ city: "Austin", state: "TX" }));
    expect(label.startsWith(",")).toBe(false);
    expect(label.endsWith(",")).toBe(false);
    expect(label).toBe("Austin, TX");
  });
});
