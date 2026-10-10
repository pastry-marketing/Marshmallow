import { afterEach, describe, expect, it, vi } from "vitest";
import { detectInstalledExtension, fetchExtensionRelease, isNewerExtension } from "./extension-release";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Donut release versioning", () => {
  it("compares numeric versions, including Chrome's optional fourth component", () => {
    expect(isNewerExtension("1.10.0", "1.9.9")).toBe(true);
    expect(isNewerExtension("1.5.0", "1.5.0.0")).toBe(false);
    expect(isNewerExtension("1.5.0.1", "1.5.0")).toBe(true);
    expect(isNewerExtension("1.5.0", "2.0.0")).toBe(false);
  });

  it("does not label a legacy or missing extension as current", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    const installed = detectInstalledExtension();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await installed).toBeNull();
  });

  it("accepts only matching, same-window version responses", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("version-request" as ReturnType<typeof crypto.randomUUID>);
    vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    const installed = detectInstalledExtension();
    const respond = (requestId: string, origin: string, version: string) => window.dispatchEvent(new MessageEvent("message", {
      source: window, origin, data: { action: "DONUT_VERSION_RESPONSE", requestId, version, releasedAt: "2026-10-10T04:00:00Z" },
    }));
    respond("unrelated", window.location.origin, "99.0.0");
    respond("version-request", "https://example.com", "99.0.0");
    respond("version-request", window.location.origin, "1.5.0");
    expect(await installed).toEqual({ version: "1.5.0", releasedAt: "2026-10-10T04:00:00Z" });
  });

  it("rejects invalid release metadata instead of displaying a fabricated version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "1.5.0", releasedAt: "invalid", summary: "Update" }) }));
    await expect(fetchExtensionRelease()).rejects.toThrow("Invalid Donut release information");
  });
});
