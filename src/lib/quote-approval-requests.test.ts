import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const supabase = {} as { rpc: ReturnType<typeof vi.fn> };
  const rpc = vi.fn(function (this: unknown) {
    if (this !== supabase) throw new Error("Supabase RPC lost its client context");
    return Promise.resolve({ data: "request-id", error: null });
  });
  const logActivity = vi.fn().mockResolvedValue(undefined);

  supabase.rpc = rpc;
  return { supabase, rpc, logActivity };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: mocks.supabase }));
vi.mock("@/lib/activity", () => ({ logActivity: mocks.logActivity }));

import { canReviewQuoteApproval, requestQuoteApproval } from "@/lib/quote-approval-requests";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("quote approval reviewers", () => {
  it.each(["admin", "cs_admin"] as const)("allows %s to approve or decline", (role) => {
    expect(canReviewQuoteApproval(role)).toBe(true);
  });

  it.each(["customer_service", "processor", "opr", "opr_admin"] as const)(
    "keeps %s in view-only mode",
    (role) => {
      expect(canReviewQuoteApproval(role)).toBe(false);
    },
  );
});

describe("requestQuoteApproval", () => {
  it("calls RPC through the Supabase client so its REST context is preserved", async () => {
    await expect(
      requestQuoteApproval({
        lead: {
          id: "lead-id",
          job_id: "LD-100",
          customer_name: "Customer",
          status: "waiting_complete_details",
        },
        requesterId: "requester-id",
      }),
    ).resolves.toBe("request-id");

    expect(mocks.rpc).toHaveBeenCalledWith("request_quote_approval", { _lead_id: "lead-id" });
    expect(mocks.logActivity).toHaveBeenCalledOnce();
  });
});
