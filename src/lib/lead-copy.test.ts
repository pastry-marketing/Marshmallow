import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompleteLeadCopyText, copyImagesToClipboard, copyTextToClipboard } from "@/lib/lead-copy";
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
  it("matches the requested four-line format exactly without expanding the address", () => {
    expect(buildCompleteLeadCopyText({
      service_details: "Need to assemble a bed with attached storage, shelves, and a pull out trundle. Picture available.",
      address: "10235 Huffmeister Rd Houston, TX 77065, USA",
      customer_schedule_requirements: "October 2, 2026",
      quote: "$150 labor only",
    } as Lead)).toBe(
      "Service Details: Need to assemble a bed with attached storage, shelves, and a pull out trundle. Picture available.\n" +
      "Address: 10235 Huffmeister Rd Houston, TX 77065, USA\n" +
      "Schedule Requirement: October 2, 2026\n" +
      "Quote: $150 labor only",
    );
  });

  it("keeps missing fields blank instead of using other fields or schedule placeholders", () => {
    expect(buildCompleteLeadCopyText({
      service_details: "   ", service_type: "Assembly", address: null,
      city: "Houston", state: "TX", zip_code: "77065",
      scheduled_date: "2026-10-02", quote: null,
    } as Lead)).toBe("Service Details: \nAddress: \nSchedule Requirement: \nQuote: ");
  });

  it("preserves full multiline details and blanks a restricted quote", () => {
    const result = buildCompleteLeadCopyText({
      service_details: " Assemble bed\nInclude the trundle. ", quote: "$150 labor only",
    } as Lead, false);
    expect(result).toBe("Service Details: Assemble bed\nInclude the trundle.\nAddress: \nSchedule Requirement: \nQuote: ");
  });

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

describe("text clipboard", () => {
  it("uses writeText when rich clipboard items are unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyTextToClipboard("Service Details: \nAddress: \nSchedule Requirement: \nQuote: ");
    expect(writeText).toHaveBeenCalledWith("Service Details: \nAddress: \nSchedule Requirement: \nQuote: ");
  });

  it("rejects a failed legacy copy and removes the temporary textarea", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    await expect(copyTextToClipboard("Details")).rejects.toThrow("Clipboard copy failed");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
