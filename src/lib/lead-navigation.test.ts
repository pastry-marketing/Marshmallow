import type { MouseEvent } from "react";
import type { NavigateFunction } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openLeadFromClick } from "@/lib/lead-navigation";

const click = (modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) =>
  ({
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  }) as MouseEvent<HTMLElement>;

describe("openLeadFromClick", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the lead in the current tab for a regular click", () => {
    const navigate = vi.fn() as unknown as NavigateFunction;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    openLeadFromClick(click(), "lead-123", navigate);

    expect(navigate).toHaveBeenCalledWith("/leads/lead-123");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the lead in a new tab while Control is held", () => {
    const navigate = vi.fn() as unknown as NavigateFunction;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    openLeadFromClick(click({ ctrlKey: true }), "lead-123", navigate);

    expect(open).toHaveBeenCalledWith("/leads/lead-123", "_blank", "noopener,noreferrer");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("supports the Command key on macOS", () => {
    const navigate = vi.fn() as unknown as NavigateFunction;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    openLeadFromClick(click({ metaKey: true }), "lead-123", navigate);

    expect(open).toHaveBeenCalledWith("/leads/lead-123", "_blank", "noopener,noreferrer");
    expect(navigate).not.toHaveBeenCalled();
  });
});
