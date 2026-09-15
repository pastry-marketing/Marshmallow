import { describe, it, expect, vi } from "vitest";
import { fetchAllRows } from "./supabase-paginate";

describe("fetchAllRows", () => {
  it("pages through until a short page and returns every row", async () => {
    // 2500 rows across pages of 1000 -> 1000, 1000, 500 (stops on the short page).
    const total = 2500;
    const makeQuery = vi.fn((from: number, to: number) => {
      const rows = [];
      for (let i = from; i <= to && i < total; i += 1) rows.push({ id: i });
      return Promise.resolve({ data: rows, error: null });
    });

    const all = await fetchAllRows<{ id: number }>(makeQuery);

    expect(all).toHaveLength(total);
    expect(all[0].id).toBe(0);
    expect(all[total - 1].id).toBe(total - 1);
    expect(makeQuery).toHaveBeenCalledTimes(3);
    expect(makeQuery.mock.calls[0]).toEqual([0, 999]);
    expect(makeQuery.mock.calls[1]).toEqual([1000, 1999]);
    expect(makeQuery.mock.calls[2]).toEqual([2000, 2999]);
  });

  it("stops after one request when the first page is not full", async () => {
    const makeQuery = vi.fn(() => Promise.resolve({ data: [{ id: 1 }, { id: 2 }], error: null }));
    const all = await fetchAllRows<{ id: number }>(makeQuery);
    expect(all).toHaveLength(2);
    expect(makeQuery).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one extra request when the total is an exact multiple of the page size", async () => {
    const makeQuery = vi.fn((from: number) =>
      Promise.resolve({ data: from === 0 ? [{ id: 1 }, { id: 2 }] : [], error: null }),
    );
    const all = await fetchAllRows<{ id: number }>(makeQuery, 2);
    expect(all).toHaveLength(2);
    // full page (2) -> tries again -> empty page stops.
    expect(makeQuery).toHaveBeenCalledTimes(2);
  });

  it("throws the query error message", async () => {
    const makeQuery = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    await expect(fetchAllRows(makeQuery)).rejects.toThrow("boom");
  });
});
