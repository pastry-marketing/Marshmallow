import { describe, expect, it } from "vitest";
import {
  CS_MISSED_TYPE_LABELS,
  formatWaited,
  resolveCsMissedWindow,
  waitSeverity,
} from "@/lib/cs-missed";

describe("formatWaited", () => {
  it("renders minutes under an hour", () => {
    expect(formatWaited(0)).toBe("0m");
    expect(formatWaited(7)).toBe("7m");
    expect(formatWaited(59)).toBe("59m");
  });

  it("renders hours and minutes", () => {
    expect(formatWaited(60)).toBe("1h");
    expect(formatWaited(95)).toBe("1h 35m");
    expect(formatWaited(23 * 60 + 59)).toBe("23h 59m");
  });

  it("renders days and hours past a day", () => {
    expect(formatWaited(24 * 60)).toBe("1d");
    expect(formatWaited(25 * 60)).toBe("1d 1h");
  });

  it("floors fractional minutes", () => {
    expect(formatWaited(7.9)).toBe("7m");
  });

  it("returns a dash for missing or invalid input", () => {
    expect(formatWaited(null)).toBe("—");
    expect(formatWaited(undefined)).toBe("—");
    expect(formatWaited(-5)).toBe("—");
    expect(formatWaited(Number.NaN)).toBe("—");
  });
});

describe("waitSeverity", () => {
  it("is fresh under an hour", () => {
    expect(waitSeverity(0)).toBe("fresh");
    expect(waitSeverity(59)).toBe("fresh");
    expect(waitSeverity(null)).toBe("fresh");
  });

  it("is warm from one hour up to a shift", () => {
    expect(waitSeverity(60)).toBe("warm");
    expect(waitSeverity(7 * 60)).toBe("warm");
  });

  it("is stale at eight hours or more", () => {
    expect(waitSeverity(8 * 60)).toBe("stale");
    expect(waitSeverity(48 * 60)).toBe("stale");
  });
});

describe("resolveCsMissedWindow", () => {
  const now = new Date("2026-06-15T18:00:00.000Z"); // 2:00 PM ET (EDT)

  it("has no bounds for 'all'", () => {
    expect(resolveCsMissedWindow("all", { now })).toEqual({ since: null, until: null });
  });

  it("looks back exactly 24h for 'last24' with an open upper bound", () => {
    const { since, until } = resolveCsMissedWindow("last24", { now });
    expect(since).toBe(new Date("2026-06-14T18:00:00.000Z").toISOString());
    expect(until).toBeNull();
  });

  it("bounds 'today' to the Eastern calendar day", () => {
    const { since, until } = resolveCsMissedWindow("today", { now });
    // 2026-06-15 in ET (EDT, -04:00)
    expect(since).toBe(new Date("2026-06-15T00:00:00.000-04:00").toISOString());
    expect(until).toBe(new Date("2026-06-15T23:59:59.999-04:00").toISOString());
  });

  it("bounds 'yesterday' to the previous Eastern calendar day", () => {
    const { since, until } = resolveCsMissedWindow("yesterday", { now });
    expect(since).toBe(new Date("2026-06-14T00:00:00.000-04:00").toISOString());
    expect(until).toBe(new Date("2026-06-14T23:59:59.999-04:00").toISOString());
  });

  it("uses the provided dates for 'custom' and leaves missing sides null", () => {
    const both = resolveCsMissedWindow("custom", { now, startDate: "2026-06-01", endDate: "2026-06-10" });
    expect(both.since).toBe(new Date("2026-06-01T00:00:00.000-04:00").toISOString());
    expect(both.until).toBe(new Date("2026-06-10T23:59:59.999-04:00").toISOString());

    const openEnded = resolveCsMissedWindow("custom", { now, startDate: "2026-06-01" });
    expect(openEnded.until).toBeNull();
  });
});

describe("CS_MISSED_TYPE_LABELS", () => {
  it("covers both follow-up types", () => {
    expect(CS_MISSED_TYPE_LABELS.missed_call).toBe("Missed call");
    expect(CS_MISSED_TYPE_LABELS.unanswered_text).toBe("Unanswered text");
  });
});
