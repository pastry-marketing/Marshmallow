import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompleteLeadCopyText, copyImagesToClipboard } from "@/lib/lead-copy";
import type { Lead } from "@/types";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("bulk photo clipboard", () => {
  it("starts one clipboard write before signing finishes and includes every photo", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage, fillRect: vi.fn(), fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const png = new Blob(["sheet"], { type: "image/png" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(png));
    vi.stubGlobal("Image", class {
      naturalWidth = 1600;
      naturalHeight = 900;
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:photo"), revokeObjectURL: revoke });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["photo"]) }));
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await items[0].data["image/png"];
    });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Promise<Blob>>) {} });
    let sign!: (urls: string[]) => void;
    const copying = copyImagesToClipboard(new Promise<string[]>((resolve) => { sign = resolve; }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toHaveLength(1);
    sign(["first", "second", "third"]);
    await copying;
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("reports download failures instead of claiming that a partial album was copied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    vi.stubGlobal("navigator", { clipboard: { write: async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await items[0].data["image/png"];
    } } });
    vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Promise<Blob>>) {} });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await copyImagesToClipboard(["expired-photo"]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe("buildCompleteLeadCopyText", () => {
  it("copies the lead text fields without picture links", () => {
    const lead = {
      service_details: "Repair the kitchen sink",
      address: "123 Main Street",
      customer_schedule_requirements: "Friday morning",
      quote: "$250",
      payment_screenshot_url: "private/payment.png",
    } as Lead;

    const result = buildCompleteLeadCopyText(lead);

    expect(result).toBe(
      "Service Details: Repair the kitchen sink\n" +
        "Address: 123 Main Street\n" +
        "Schedule Requirement: Friday morning\n" +
        "Quote: $250",
    );
    expect(result).not.toContain("Pictures");
    expect(result).not.toContain("private/payment.png");
  });
});
