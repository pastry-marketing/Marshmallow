import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Execute the shipped extension handlers with browser APIs stubbed, so recipient
// regressions are caught without sending a real MMS.
function handler(file: string, name: string, next: string, globals: Record<string, unknown>) {
  const source = readFileSync(resolve(process.cwd(), "tmp_extension/quo-crm-extension", file), "utf8");
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(next, start);
  return runInNewContext(`${source.slice(start, end)}\n${name}`, globals);
}

const conversationId = (url: string) => url.match(/\/c\/([^/?]+)/)?.[1] || null;

describe("extension technician photo routing", () => {
  it("rejects old CRM customer requests before downloading photos", async () => {
    const fetch = vi.fn();
    const send = handler("background.js", "handleQuoSendAttachments", "async function handleQuoPrepareChat", {
      URL, fetch, conversationIdFromUrl: conversationId,
    });
    const result = await send({ chatUrl: "https://my.quo.com/inbox/c/customer", imageUrls: ["photo"] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("selected technician");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects phone-search targets even with technician metadata", async () => {
    const fetch = vi.fn();
    const send = handler("background.js", "handleQuoSendAttachments", "async function handleQuoPrepareChat", {
      URL, fetch, conversationIdFromUrl: conversationId,
    });
    const result = await send({ chatUrl: "https://my.quo.com/inbox?phone=14155550123", imageUrls: ["photo"], recipientType: "tech", technicianPhone: "+14155550123" });
    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["attach", "send"])("stops if the user switches to the customer conversation before %s", async (stage) => {
    const location = { href: "https://my.quo.com/inbox/c/tech-chat" };
    const frame = { location, top: null as unknown };
    frame.top = frame;
    const click = vi.fn();
    const inject = vi.fn().mockResolvedValue("input");
    const send = handler("content.js", "handleNavigateAndSendAttachments", "// Helper to wait for element", {
      window: frame, console, getConversationId: conversationId,
      COMPOSER_SELECTORS: [], waitForAny: async () => ({}),
      dataUrlToFile: async () => {
        if (stage === "attach") location.href = "https://my.quo.com/inbox/c/customer";
        return {};
      },
      countAttachmentPreviews: () => 0,
      injectAttachments: inject,
      setTimeout: (callback: () => void) => callback(),
      findEnabledSendButton: () => {
        location.href = "https://my.quo.com/inbox/c/customer";
        return { click };
      },
    });
    const result = await send("https://my.quo.com/inbox/c/tech-chat", [{}], true, "tech", "+14155550123");
    expect(result.success).toBe(false);
    expect(result.error).toContain("conversation changed");
    expect(click).not.toHaveBeenCalled();
    if (stage === "attach") expect(inject).not.toHaveBeenCalled();
  });
});
