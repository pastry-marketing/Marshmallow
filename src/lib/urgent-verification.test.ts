import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));

import { supabase } from "@/integrations/supabase/client";
import {
  applyUrgentAcknowledgement,
  applyUrgentVerification,
  bypassesUrgentGate,
  runUrgentVerification,
  submitUrgentReviewRequest,
} from "./urgent-verification";

const invoke = () => vi.mocked(supabase.functions.invoke);
const rpc = () => vi.mocked(supabase.rpc);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bypassesUrgentGate", () => {
  // These four mirror enforce_urgent_gate() in
  // 20261104000000_urgent_review_gate.sql. The list exists to spare a user a
  // pointless dialog; the trigger is what actually enforces the rule, so a
  // mismatch here is a UX bug rather than a security hole.
  it("lets the operational roles through", () => {
    expect(bypassesUrgentGate("admin")).toBe(true);
    expect(bypassesUrgentGate("processor")).toBe(true);
    expect(bypassesUrgentGate("cs_admin")).toBe(true);
  });

  it("holds customer_service and the read-only roles back", () => {
    expect(bypassesUrgentGate("customer_service")).toBe(false);
    expect(bypassesUrgentGate("opr")).toBe(false);
    expect(bypassesUrgentGate("opr_admin")).toBe(false);
  });

  it("treats an unknown or absent role as no bypass", () => {
    expect(bypassesUrgentGate(null)).toBe(false);
    expect(bypassesUrgentGate(undefined)).toBe(false);
    expect(bypassesUrgentGate("")).toBe(false);
    // A role that does not exist must not be waved through.
    expect(bypassesUrgentGate("superuser")).toBe(false);
  });
});

describe("runUrgentVerification", () => {
  it("reports a clean check", async () => {
    invoke().mockResolvedValue({
      data: { verification: "checked", clean: true, issues: [], summary: "All good", conversation_found: true, message_count: 12, elapsed_ms: 1800 },
      error: null,
    } as never);

    const result = await runUrgentVerification("lead-1");

    expect(result.state).toBe("checked");
    expect(result.issues).toHaveLength(0);
    expect(result.summary).toBe("All good");
    expect(result.messageCount).toBe(12);
    expect(invoke()).toHaveBeenCalledWith("check-urgent-lead", { body: { leadId: "lead-1" } });
  });

  it("surfaces findings with their evidence", async () => {
    const issues = [
      { check: "schedule", field: "customer_schedule_requirements", severity: "high", problem: "Narrower than agreed", evidence: "3rd or 4th", suggestion: "Keep both days" },
    ];
    invoke().mockResolvedValue({
      data: { verification: "checked", clean: false, issues, summary: "One mismatch", conversation_found: true, message_count: 30, elapsed_ms: 2400 },
      error: null,
    } as never);

    const result = await runUrgentVerification("lead-2");

    expect(result.state).toBe("checked");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].evidence).toBe("3rd or 4th");
  });

  it("separates 'could not verify' from 'found problems'", async () => {
    // 44% of leads have no matched conversation. That must never come back as a
    // finding, because a finding sends it to a human queue, and it must never
    // come back as clean, because that claims a check that never ran.
    invoke().mockResolvedValue({
      data: { verification: "unavailable", clean: false, issues: [], notice: "No conversation was found", conversation_found: false, message_count: 0, elapsed_ms: 40 },
      error: null,
    } as never);

    const result = await runUrgentVerification("lead-3");

    expect(result.state).toBe("unavailable");
    expect(result.issues).toHaveLength(0);
    expect(result.conversationFound).toBe(false);
    expect(result.notice).toContain("No conversation");
  });

  it("treats a transport failure as unknown, never as a pass", async () => {
    invoke().mockResolvedValue({ data: null, error: { message: "Functions fetch failed" } } as never);

    const result = await runUrgentVerification("lead-4");

    expect(result.state).toBe("error");
    expect(result.issues).toHaveLength(0);
  });

  it("does not trust a missing verification flag", async () => {
    // If the field is absent the result is not "checked". Defaulting to clean
    // here would be the one bug that quietly disables the whole feature.
    invoke().mockResolvedValue({
      data: { clean: true, issues: [] },
      error: null,
    } as never);

    const result = await runUrgentVerification("lead-5");

    expect(result.state).toBe("unavailable");
  });

  it("tolerates a malformed issues payload", async () => {
    invoke().mockResolvedValue({
      data: { verification: "checked", clean: false, issues: "not-an-array" },
      error: null,
    } as never);

    const result = await runUrgentVerification("lead-6");

    expect(result.issues).toEqual([]);
  });

  it("refuses an empty lead id before making a call", async () => {
    await expect(runUrgentVerification("")).rejects.toThrow("Missing lead ID");
    expect(invoke()).not.toHaveBeenCalled();
  });
});

describe("apply paths", () => {
  it("records a passed verification", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await applyUrgentVerification("lead-1", "Nothing contradicts the conversation");

    expect(rpc()).toHaveBeenCalledWith("approve_urgent_verification", {
      p_lead_id: "lead-1",
      p_ai_summary: "Nothing contradicts the conversation",
      p_ai_model: "gpt-4o-mini",
    });
  });

  it("records an acknowledgement rather than a passed check", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await applyUrgentAcknowledgement("lead-2", "No conversation available to check");

    // A different RPC on purpose. Sending this through the verification path
    // would log "all checks passed" for a lead nobody ever checked.
    expect(rpc()).toHaveBeenCalledWith("approve_urgent_acknowledgement", {
      p_lead_id: "lead-2",
      p_reason: "No conversation available to check",
    });
  });

  it("queues a review request with the findings attached", async () => {
    rpc().mockResolvedValue({ data: "request-1", error: null } as never);

    const id = await submitUrgentReviewRequest({
      leadId: "lead-3",
      issues: [{ check: "urgency", field: "", severity: "low", problem: "p", evidence: "e", suggestion: "s" }],
      summary: "One thing",
      jobId: "LD-1",
      customerName: "Aaron",
      previousStatus: "need_tech",
    });

    expect(id).toBe("request-1");
    expect(rpc()).toHaveBeenCalledWith("request_urgent_review", expect.objectContaining({
      p_lead_id: "lead-3",
      p_lead_job_id: "LD-1",
      p_previous_status: "need_tech",
    }));
  });

  it("surfaces the database error rather than failing quietly", async () => {
    rpc().mockResolvedValue({ data: null, error: { message: "permission denied" } } as never);

    await expect(applyUrgentVerification("lead-4", "")).rejects.toThrow("permission denied");
  });
});