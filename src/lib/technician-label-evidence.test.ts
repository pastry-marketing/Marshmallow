import { describe, expect, it } from "vitest";
import { supportsTechnicianLabel } from "../../supabase/functions/_shared/technician-label-evidence";

const tech = (label: string, quote: string) => [{ label, quote, source: "Technician / contact" }];

describe("supportsTechnicianLabel", () => {
  it("does not treat a refund discussion as late payment or non-cooperation", () => {
    expect(supportsTechnicianLabel("late_payment", tech("late_payment", "Yes but I'm able to return"))).toBe(false);
    expect(supportsTechnicianLabel("dont_cooperate", tech("dont_cooperate", "I'd like to back out of this job and get my money back."))).toBe(false);
  });

  it("does not label service boundaries as non-cooperation", () => {
    expect(supportsTechnicianLabel("dont_cooperate", tech("dont_cooperate", "We are a plumbing company; we do not do the services you're recommending."))).toBe(false);
  });

  it("requires the technician's explicit admission for overdue payment", () => {
    expect(supportsTechnicianLabel("late_payment", [{ label: "late_payment", quote: "Did you send our cut?", source: "Our team" }])).toBe(false);
    expect(supportsTechnicianLabel("late_payment", tech("late_payment", "I owe you the share. I'm late on my payment."))).toBe(true);
  });

  it("allows explicit refusal of an assigned job and ordinary labels with verified quotes", () => {
    expect(supportsTechnicianLabel("dont_cooperate", tech("dont_cooperate", "I refuse to complete this job."))).toBe(true);
    expect(supportsTechnicianLabel("high_rates", tech("high_rates", "My rate is $600 for this visit."))).toBe(true);
  });

  it("does not mistake accusations or polite chat for fraud or Good Tech", () => {
    expect(supportsTechnicianLabel("tech_is_scammer", [{ label: "tech_is_scammer", quote: "Why are you scamming us?", source: "Our team" }])).toBe(false);
    expect(supportsTechnicianLabel("good_tech", tech("good_tech", "You're welcome!"))).toBe(false);
    expect(supportsTechnicianLabel("good_tech", [{ label: "good_tech", quote: "The customer was happy with your excellent work", source: "Our team" }])).toBe(true);
  });
});
