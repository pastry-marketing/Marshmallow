import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

import { supabase } from "@/integrations/supabase/client";
import {
  fetchAreaLeaderboard,
  fetchOptimizedAreas,
  formatAreaLabel,
  type ResolvedLocation,
} from "./area-optimization";

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

describe("fetchAreaLeaderboard", () => {
  it("requests the leaderboard RPC with the requested limit", async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValue({ data: [], error: null } as never);

    await fetchAreaLeaderboard(25);

    expect(rpc).toHaveBeenCalledWith("area_leaderboard", { _limit: 25 });
  });

  it("defaults to 25 rows so the table is bounded on a large account", async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValue({ data: [], error: null } as never);

    await fetchAreaLeaderboard();

    expect(rpc).toHaveBeenCalledWith("area_leaderboard", { _limit: 25 });
  });

  it("returns the rows unchanged, keeping the counts the ranking used", async () => {
    const rpc = vi.mocked(supabase.rpc);
    const rows = [
      {
        state: "CA",
        cities: "Los Angeles, San Diego",
        technicians: 91,
        closed_count: 92,
        cancelled_count: 47,
        scheduled_count: 63,
        closed_rate_pct: 66.2,
        is_optimised: false,
        last_closed_at: "2026-10-01T00:00:00Z",
      },
    ];
    rpc.mockResolvedValue({ data: rows, error: null } as never);

    const result = await fetchAreaLeaderboard();

    expect(result).toHaveLength(1);
    expect(result[0].state).toBe("CA");
    expect(result[0].closed_count).toBe(92);
    expect(result[0].closed_rate_pct).toBe(66.2);
    expect(result[0].is_optimised).toBe(false);
  });

  it("returns an empty list rather than undefined when the RPC yields no rows", async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValue({ data: null, error: null } as never);

    await expect(fetchAreaLeaderboard()).resolves.toEqual([]);
  });

  it("surfaces an RPC error instead of rendering an empty table as if nothing closed", async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValue({ data: null, error: new Error("boom") } as never);

    await expect(fetchAreaLeaderboard()).rejects.toThrow("boom");
  });
});

describe("fetchOptimizedAreas", () => {
  it("returns an empty list when nothing has been marked yet", async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValue({ data: null, error: null } as never);

    await expect(fetchOptimizedAreas()).resolves.toEqual([]);
  });

  it("keeps marked and unmarked rows, since unmarking preserves history", async () => {
    const rpc = vi.mocked(supabase.rpc);
    const rows = [
      { id: 1, state: "TX", is_active: true, paid_count: 68 },
      { id: 2, state: "NY", is_active: false, paid_count: 12 },
    ];
    rpc.mockResolvedValue({ data: rows, error: null } as never);

    const result = await fetchOptimizedAreas();

    expect(result.map((r) => r.is_active)).toEqual([true, false]);
  });
});