import { beforeEach, describe, expect, it, vi } from "vitest";
import { TECH_COMMUNICATIONS_NUMBER } from "./quo-dashboard";

const mocks = vi.hoisted(() => ({ order: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mocks.from },
}));
import { resolveTechPhotoChat } from "./quo-tech-photos";

const conversation = (id: string, participant: string, line: string) => ({
  quo_conversation_id: id,
  customer_number: participant,
  quo_phone_numbers: { quo_phone_number_id: "PN-tech", number: line, display_number: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReturnValue({ select: () => ({ or: () => ({ order: mocks.order }) }) });
});

describe("resolveTechPhotoChat", () => {
  it("selects the technician line and exact participant rather than a newer customer chat", async () => {
    mocks.order.mockResolvedValue({ data: [
      conversation("customer-chat", "+14155550123", "+14155559999"),
      conversation("wrong-tech", "+4414155550123", TECH_COMMUNICATIONS_NUMBER),
      conversation("assigned-tech", "+14155550123", TECH_COMMUNICATIONS_NUMBER),
    ] });
    await expect(resolveTechPhotoChat("(415) 555-0123")).resolves.toBe("https://my.quo.com/inbox/PN-tech/c/assigned-tech");
  });

  it("never falls back to the customer line when there is no tech conversation", async () => {
    mocks.order.mockResolvedValue({ data: [conversation("customer-chat", "+14155550123", "+14155559999")] });
    await expect(resolveTechPhotoChat("4155550123")).rejects.toThrow("No technician Quo conversation found");
  });

  it("requires a valid technician number before reading conversations", async () => {
    await expect(resolveTechPhotoChat("")).rejects.toThrow("valid phone number");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("surfaces RLS/query failures without dispatching to another chat", async () => {
    mocks.order.mockResolvedValue({ data: null, error: { message: "Permission denied" } });
    await expect(resolveTechPhotoChat("4155550123")).rejects.toThrow("Permission denied");
  });
});
