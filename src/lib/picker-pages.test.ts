import { describe, expect, it } from "vitest";

import { buildPickerPages } from "./picker-pages";

describe("buildPickerPages", () => {
  it("lists every page when the list is short", () => {
    expect(buildPickerPages(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles a single page and an empty list without inventing pages", () => {
    expect(buildPickerPages(1, 1)).toEqual([1]);
    expect(buildPickerPages(1, 0)).toEqual([]);
  });

  it("keeps the first and last page while collapsing the middle", () => {
    const pages = buildPickerPages(8, 15);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(15);
    expect(pages).toContain("ellipsis-left");
    expect(pages).toContain("ellipsis-right");
  });

  it("omits the left ellipsis when the reader is near the start", () => {
    expect(buildPickerPages(2, 15)).not.toContain("ellipsis-left");
    expect(buildPickerPages(2, 15)).toContain("ellipsis-right");
  });

  it("omits the right ellipsis when the reader is near the end", () => {
    expect(buildPickerPages(14, 15)).toContain("ellipsis-left");
    expect(buildPickerPages(14, 15)).not.toContain("ellipsis-right");
  });

  it("never returns duplicate page numbers", () => {
    for (const [current, total] of [[1, 15], [8, 15], [15, 15], [7, 7], [3, 9]] as const) {
      const numbers = buildPickerPages(current, total).filter((page): page is number => typeof page === "number");
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(Math.min(...numbers)).toBe(1);
      expect(Math.max(...numbers)).toBe(total);
    }
  });
});