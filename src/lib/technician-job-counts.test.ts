import { describe, expect, it } from "vitest";
import { technicianJobCounts, technicianPhoneKey } from "../../supabase/functions/_shared/technician-job-counts";

describe("technicianPhoneKey", () => {
  it("normalizes US national and country-code formats but rejects incomplete numbers", () => {
    expect(technicianPhoneKey("(765) 736-1066")).toBe("7657361066");
    expect(technicianPhoneKey("+1 765-736-1066")).toBe("7657361066");
    expect(technicianPhoneKey("736-1066")).toBeNull();
    expect(technicianPhoneKey("+44 765 736 1066")).toBeNull();
  });
});

describe("technicianJobCounts", () => {
  const leads = [
    { tech_number: "+1 765 736 1066", status: "paid" },
    { tech_number: "7657361066", status: "job_done" },
    { tech_number: "(678) 463-0818", status: "paid" },
    { tech_number: null, status: "paid" },
  ];

  it("does not assign another technician's same-name jobs to this phone", () => {
    expect(technicianJobCounts("(765) 736-1066", leads)).toEqual({ completed: 2, paid: 1, error: null });
    expect(technicianJobCounts("6784630818", leads)).toEqual({ completed: 1, paid: 1, error: null });
  });

  it("distinguishes zero matching jobs from missing identification", () => {
    expect(technicianJobCounts("8284577705", leads)).toEqual({ completed: 0, paid: 0, error: null });
    expect(technicianJobCounts(null, leads)).toEqual({
      completed: null,
      paid: null,
      error: "No valid technician phone number is available to match leads.",
    });
  });
});
