import { describe, expect, it } from "vitest";
import { technicianReviewState } from "./technician-review";

describe("technician review data quality", () => {
  it("does not present missing history as a successful or negative assessment", () => {
    expect(technicianReviewState({ reviewed: true, messages: 0, suggestedLabels: [] })).toBe("unavailable");
    expect(technicianReviewState({ reviewed: true, error: "Quo unavailable", messages: 0, suggestedLabels: ["never_responded"] })).toBe("unavailable");
  });

  it("distinguishes a neutral reviewed conversation from one awaiting assessment", () => {
    expect(technicianReviewState({ reviewed: true, messages: 15, suggestedLabels: [] })).toBe("manual_review");
    expect(technicianReviewState({ reviewed: false, messages: 0, suggestedLabels: [] })).toBe("not_reviewed");
  });

  it("requires a reviewed, nonempty history before displaying supported suggestions", () => {
    expect(technicianReviewState({ reviewed: true, messages: 20, suggestedLabels: ["good_tech"] })).toBe("supported");
    expect(technicianReviewState({ reviewed: true, error: "Save failed", messages: 20, suggestedLabels: ["good_tech"] })).toBe("unavailable");
  });
});
