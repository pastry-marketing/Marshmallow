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
  showsUrgentCheck,
  showsUrgentCheckRole,
  URGENT_CHECK_ENABLED,
} from "./urgent-verification";

const invoke = () => vi.mocked(supabase.functions.invoke);
const rpc = () => vi.mocked(supabase.rpc);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("showsUrgentCheck", () => {
  // The check is temporarily switched off, so nobody is asked whatever their
  // role. The role rules themselves are still covered below, through
  // showsUrgentCheckRole, so turning the feature back on is a one-line change
  // against tests that never stopped describing the intended behaviour.
  it("asks nobody while the check is switched off", () => {
    expect(URGENT_CHECK_ENABLED).toBe(false);

    for (const role of ["customer_service", "admin", "cs_admin", "processor", "opr", "opr_admin"]) {
      expect(showsUrgentCheck(role)).toBe(false);
    }
  });
});

describe("showsUrgentCheckRole", () => {
  // Who is asked is separate from what the database permits. processor sets
  // urgent directly and is never asked; customer_service, admin and cs_admin all
  // see the same advisory check and nobody is queued for review.
  it("asks customer_service, admin and cs_admin", () => {
    expect(showsUrgentCheckRole("customer_service")).toBe(true);
    expect(showsUrgentCheckRole("admin")).toBe(true);
    expect(showsUrgentCheckRole("cs_admin")).toBe(true);
  });

  it("does not ask processor", () => {
    expect(showsUrgentCheckRole("processor")).toBe(false);
  });

  it("does not ask the read-only roles", () => {
    expect(showsUrgentCheckRole("opr")).toBe(false);
    expect(showsUrgentCheckRole("opr_admin")).toBe(false);
  });

  it("does not ask an unknown or absent role", () => {
    expect(showsUrgentCheckRole(null)).toBe(false);
    expect(showsUrgentCheckRole(undefined)).toBe(false);
    expect(showsUrgentCheckRole("")).toBe(false);
    expect(showsUrgentCheckRole("superuser")).toBe(false);
  });

  it("keeps the asked list distinct from the database's exempt list", () => {
    // processor is exempt in the database and never asked. If these two lists
    // were collapsed into one, processor would either start seeing the dialog or
    // lose the ability to set urgent directly. They are meant to disagree here.
    expect(bypassesUrgentGate("processor")).toBe(true);
    expect(showsUrgentCheckRole("processor")).toBe(false);

    // customer_service is the mirror image: gated in the database, and asked.
    expect(bypassesUrgentGate("customer_service")).toBe(false);
    expect(showsUrgentCheckRole("customer_service")).toBe(true);
  });
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
    // Carries an abort signal as well as the body, so a stalled request cannot
    // leave the dialog spinning forever.
    expect(invoke()).toHaveBeenCalledWith(
      "check-urgent-lead",
      expect.objectContaining({ body: { leadId: "lead-1" } }),
    );
    const options = invoke().mock.calls[0][1] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a timeout as unknown rather than as a pass", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    invoke().mockResolvedValue({ data: null, error: abort } as never);

    const result = await runUrgentVerification("lead-timeout");

    expect(result.state).toBe("error");
    expect(result.issues).toHaveLength(0);
    expect(result.notice).toContain("did not respond in time");
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

  it("surfaces the function's own reason from the response body", async () => {
    // supabase-js puts the edge function's JSON body in error.context, and
    // error.message stays the generic "non-2xx status code". Reading only the
    // message is why a quota failure and a revoked key looked identical.
    const response = new Response(
      JSON.stringify({ error: "The AI key has no quota left.", reason: "ai_out_of_quota" }),
      { status: 502 },
    );
    invoke().mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context: response }),
    } as never);

    const result = await runUrgentVerification("lead-quota");

    expect(result.state).toBe("error");
    expect(result.reason).toBe("ai_out_of_quota");
    expect(result.notice).toContain("no quota left");
  });

  it("still reports something useful when the body is not JSON", async () => {
    const response = new Response("<html>502</html>", { status: 502 });
    invoke().mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context: response }),
    } as never);

    const result = await runUrgentVerification("lead-html");

    expect(result.state).toBe("error");
    expect(result.reason).toBe("unknown");
    expect(result.notice).toBeTruthy();
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

  it("keeps a summary on the override path so no clean check is implied", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    // approve_urgent_verification falls back to 'All verification checks passed'
    // when it receives nothing. The dialog passes an explicit summary on the
    // override path precisely so proceeding over findings does not write a clean
    // check into the activity log.
    await applyUrgentVerification(
      "lead-5",
      "Proceeded over 2 findings: schedule is narrower than the customer agreed",
    );

    expect(rpc()).toHaveBeenCalledWith("approve_urgent_verification", {
      p_lead_id: "lead-5",
      p_ai_summary: "Proceeded over 2 findings: schedule is narrower than the customer agreed",
      p_ai_model: "gpt-4o-mini",
    });
  });
});
