import { describe, expect, it } from "vitest";

import { canReviewQuoteApproval } from "@/lib/quote-approval-requests";

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
