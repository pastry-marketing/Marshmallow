import { describe, it, expect } from "vitest";
import {
  isQuoChatUrl,
  batchForQuo,
  QUO_MAX_IMAGES_PER_MESSAGE,
  QUO_MAX_BYTES_PER_MESSAGE,
} from "./quo-attachments";

describe("isQuoChatUrl", () => {
  it("accepts quo.com and its subdomains", () => {
    expect(isQuoChatUrl("https://my.quo.com/inbox/c/abc123")).toBe(true);
    expect(isQuoChatUrl("https://quo.com/inbox?phone=5551234567")).toBe(true);
  });

  it("still accepts legacy openphone.com links", () => {
    expect(isQuoChatUrl("https://my.openphone.com/inbox/c/abc")).toBe(true);
  });

  it("rejects non-Quo and malformed urls", () => {
    expect(isQuoChatUrl("https://example.com/c/abc")).toBe(false);
    expect(isQuoChatUrl("not a url")).toBe(false);
    expect(isQuoChatUrl("")).toBe(false);
    expect(isQuoChatUrl(null)).toBe(false);
    expect(isQuoChatUrl(undefined)).toBe(false);
  });

  it("does not treat a lookalike host as Quo", () => {
    expect(isQuoChatUrl("https://notquo.com/x")).toBe(false);
    expect(isQuoChatUrl("https://quo.com.evil.test/x")).toBe(false);
  });
});

describe("batchForQuo", () => {
  it("returns no batches for an empty list", () => {
    expect(batchForQuo([])).toEqual([]);
  });

  it("keeps everything in one batch when within both limits", () => {
    const items = Array.from({ length: 5 }, () => ({ size: 100 }));
    const batches = batchForQuo(items);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
  });

  it("splits on the 10-image count limit", () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ id: i, size: 1 }));
    const batches = batchForQuo(items);
    expect(batches.map((b) => b.length)).toEqual([10, 4]);
    // order is preserved end to end
    expect(batches.flat().map((b) => b.id)).toEqual(items.map((i) => i.id));
  });

  it("splits on the 5MB size limit before the count limit", () => {
    const threeMb = 3 * 1024 * 1024;
    const items = Array.from({ length: 4 }, (_, i) => ({ id: i, size: threeMb }));
    const batches = batchForQuo(items);
    // two 3MB images already exceed 5MB, so one per message
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1, 1]);
  });

  it("never drops an oversized item that alone exceeds the byte budget", () => {
    const huge = QUO_MAX_BYTES_PER_MESSAGE + 1;
    const batches = batchForQuo([{ size: huge }, { size: 10 }]);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
  });

  it("treats a missing size as zero", () => {
    const items = Array.from({ length: QUO_MAX_IMAGES_PER_MESSAGE + 1 }, () => ({}));
    const batches = batchForQuo(items);
    expect(batches.map((b) => b.length)).toEqual([QUO_MAX_IMAGES_PER_MESSAGE, 1]);
  });
});
