import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the shipped extension handler, which runs outside the Vite module graph.
const source = readFileSync("tmp_extension/quo-crm-extension/content.js", "utf8");
const handler = source.slice(source.indexOf("async function handlePreparePhotos("), source.indexOf("function composerText("));
const chatUrl = "https://my.quo.com/inbox/PN-tech/c/assigned-tech";

function setup(pathname = "/inbox/PN-tech/c/assigned-tech") {
  const change = vi.fn();
  const editor = {};
  const input = { disabled: false, multiple: true, accept: "image/*", files: [] as File[], dispatchEvent: change };
  const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["original"], { type: "image/jpeg" }) });
  const window = { location: { href: `https://my.quo.com${pathname}` }, top: null as unknown };
  window.top = window;
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => this.files.push(file) };
  }
  const prepare = runInNewContext(`${handler}; handlePreparePhotos`, {
    window, URL, File, Event, DataTransfer: Transfer,
    AbortSignal: { timeout: () => new AbortController().signal },
    fetch, waitForAny: async () => editor, COMPOSER_SELECTORS: [], findComposer: () => editor,
    document: { querySelectorAll: () => [input] },
  }) as (chat: string, photos: string[]) => Promise<{ success: boolean; error?: string }>;
  return { prepare, fetch, input, change, window };
}

describe("Donut original-photo handoff", () => {
  it("hands every original to the file input in order without clicking Send", async () => {
    const { prepare, input, change } = setup();
    expect(await prepare(chatUrl, ["first", "second", "third"])).toEqual({ success: true });
    expect(input.files.map((file) => file.name)).toEqual(["lead-photo-1.jpg", "lead-photo-2.jpg", "lead-photo-3.jpg"]);
    expect(input.files.every((file) => file.type === "image/jpeg" && file.size === 8)).toBe(true);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("refuses a different communications line even with the same conversation ID", async () => {
    const { prepare, fetch, change } = setup("/inbox/PN-customer/c/assigned-tech");
    expect((await prepare(chatUrl, ["photo"])).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  it("does not attach a partial batch when a download fails", async () => {
    const { prepare, fetch, change } = setup();
    fetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["photo"], { type: "image/png" }) })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    expect((await prepare(chatUrl, ["first", "expired"])).error).toContain("Photo 2 download failed");
    expect(change).not.toHaveBeenCalled();
  });

  it("leaves the composer untouched if the user switches chats during download", async () => {
    const { prepare, fetch, change, window } = setup();
    fetch.mockImplementation(async () => {
      window.location.href = "https://my.quo.com/inbox/PN-tech/c/someone-else";
      return { ok: true, blob: async () => new Blob(["photo"], { type: "image/png" }) };
    });
    expect((await prepare(chatUrl, ["photo"])).error).toContain("chat changed");
    expect(change).not.toHaveBeenCalled();
  });
});
