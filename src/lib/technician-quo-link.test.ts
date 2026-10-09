import { describe, expect, it } from "vitest";
import { parseTechnicianQuoLink } from "../../supabase/functions/_shared/technician-quo-link";

describe("parseTechnicianQuoLink", () => {
  it("extracts only trusted inbox identifiers", () => {
    expect(parseTechnicianQuoLink("https://my.quo.com/inbox/PN12345678/c/CNabcdef123456"))
      .toEqual({ phoneNumberId: "PN12345678", conversationId: "CNabcdef123456" });
    expect(parseTechnicianQuoLink("https://other.example/inbox/PN12345678/c/CNabcdef123456")).toBeNull();
    expect(parseTechnicianQuoLink("http://my.quo.com/inbox/PN12345678/c/CNabcdef123456")).toBeNull();
    expect(parseTechnicianQuoLink("https://my.quo.com/inbox/PN12345678/c/invalid")).toBeNull();
  });
});
