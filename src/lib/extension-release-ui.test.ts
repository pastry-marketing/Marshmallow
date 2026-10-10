import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const source = readFileSync("tmp_extension/quo-crm-extension/release-status.js", "utf8");
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("Donut panel release notices", () => {
  it("shows the installed version/date and a manual ZIP notice for a newer numeric version", async () => {
    document.body.innerHTML = '<p id="donut-release-status"></p><section id="donut-update-notice" hidden></section>';
    const fetch = vi.fn().mockResolvedValueOnce({ json: async () => ({ releasedAt: "2026-10-10T04:00:00Z" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: "1.10.0", releasedAt: "2026-10-11T04:00:00Z" }) });
    await runInNewContext(source, {
      document, Intl, Date, URL, fetch,
      window: { addEventListener: vi.fn(), setInterval: vi.fn() },
      AbortSignal: { timeout: () => new AbortController().signal },
      chrome: { runtime: {
        getManifest: () => ({ version: "1.9.0" }), getURL: (file: string) => `chrome-extension://donut/${file}`,
        sendMessage: async () => ({ settings: { apiBaseUrl: "https://marshmallow-crm.lovable.app" } }),
      }, storage: { onChanged: { addListener: vi.fn() } } },
    });
    await waitFor(() => expect(document.getElementById("donut-update-notice")?.hidden).toBe(false));
    expect(document.getElementById("donut-release-status")?.textContent).toContain("Donut v1.9.0 • Released");
    expect(document.getElementById("donut-update-notice")?.textContent).toContain("reload Donut in chrome://extensions");
    expect(document.querySelector("#donut-update-notice a")?.getAttribute("href"))
      .toBe("https://marshmallow-crm.lovable.app/Donut.zip?v=1.10.0");
  });
});
