import { describe, it, expect, beforeAll } from "vitest";
import { preloadZipDataset, lookupAreaCentroidSync } from "./zipCentroids";

// These cover the technician-map fix: an "area" of "City, ST" (no ZIP) must
// still resolve to a centroid so the tech shows on the map.
describe("lookupAreaCentroidSync", () => {
  beforeAll(async () => {
    await preloadZipDataset();
  });

  it("resolves a 'City, ST' area that has no ZIP", () => {
    const r = lookupAreaCentroidSync("Miami, FL");
    expect(r).not.toBeNull();
    expect(r!.state).toBe("FL");
    // Miami sits at roughly 25.7, -80.2.
    expect(r!.latitude).toBeGreaterThan(24);
    expect(r!.latitude).toBeLessThan(27);
    expect(r!.longitude).toBeGreaterThan(-81);
    expect(r!.longitude).toBeLessThan(-79);
  });

  it("resolves a full state name", () => {
    const r = lookupAreaCentroidSync("Dallas, Texas");
    expect(r).not.toBeNull();
    expect(r!.state).toBe("TX");
    expect(r!.latitude).toBeGreaterThan(31);
    expect(r!.latitude).toBeLessThan(34);
  });

  it("resolves 'City ST' without a comma", () => {
    const r = lookupAreaCentroidSync("Houston TX");
    expect(r).not.toBeNull();
    expect(r!.state).toBe("TX");
  });

  it("still resolves an embedded ZIP code", () => {
    const r = lookupAreaCentroidSync("anything 33101");
    expect(r).not.toBeNull();
    expect(r!.zip).toBe("33101");
  });

  it("returns null for text that matches no place", () => {
    expect(lookupAreaCentroidSync("zzqqxx not a place")).toBeNull();
    expect(lookupAreaCentroidSync("")).toBeNull();
    expect(lookupAreaCentroidSync(null)).toBeNull();
  });
});
