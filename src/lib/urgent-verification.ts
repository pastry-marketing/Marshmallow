import { supabase } from "@/integrations/supabase/client";

// =============================================================================
// Client side of the urgent verification.
//
// Three outcomes, and the difference between them is the whole point.
//
//   checked + no issues   the record matches the conversation. Proceed.
//   checked + issues      something disagrees. A person has to look.
//   unavailable           nothing could be compared at all. A person has to say
//                         so on purpose.
//
// "unavailable" is not an issue and not a pass. It covers the 44% of leads with
// no matched conversation, and treating it as either extreme is wrong: calling
// it a finding sends half the urgent queue to a human forever, and calling it
// clean claims a check that never ran. It gets its own state, and the log
// records an acknowledgement rather than a passed verification.
// =============================================================================

export type UrgentVerificationState = "idle" | "running" | "checked" | "unavailable" | "error";

/**
 * Who gets asked before a lead goes urgent.
 *
 *   customer_service, admin, cs_admin   the check runs and the findings are shown
 *   processor                          not asked
 *
 * Processor dispatch, they set urgent directly, and the database still exempts
 * them. Putting a two second check in front of the people whose job is moving the
 * queue would slow the one path that must not slow.
 *
 * Nobody is blocked by a finding and nobody is queued for review. The check tells
 * the person making the call whether the record disagrees with the customer, and
 * they decide. That is a deliberate change from routing customer_service to a CS
 * Admin: a queue that carries most of the urgent work stops being read within a
 * week, and a review step that gets rubber-stamped is worse than none because it
 * still looks like a control.
 *
 * What still holds is the database trigger. It refuses a raw write that carries
 * no verification at all, so the check cannot be skipped by calling the API
 * directly or from the extension. The dialog is how you satisfy it; it is not
 * what makes it true.
 *
 * This is presentation only. enforce_urgent_gate() exempts admin, processor and
 * cs_admin in the database regardless, so this governs what someone is shown,
 * never what they are permitted to do. If the front end were the thing enforcing
 * the rule it could be bypassed with one request, and if the database started
 * blocking those roles a dispatch workflow could jam on work that cannot wait.
 */

/**
 * Roles the database gate lets straight through.
 *
 * Kept in step with the bypass list in enforce_urgent_gate(). Note it includes
 * processor, who is never asked, because the database still exempts them.
 */
export function bypassesUrgentGate(role: string | null | undefined): boolean {
  return role === "admin" || role === "processor" || role === "cs_admin";
}

export function showsUrgentCheck(role: string | null | undefined): boolean {
  const r = role ?? "";
  return r === "customer_service" || r === "admin" || r === "cs_admin";
}

export type UrgentIssue = {
  check: string;
  field: string;
  severity: "high" | "medium" | "low";
  problem: string;
  evidence: string;
  suggestion: string;
};

export type UrgentVerificationResult = {
  state: UrgentVerificationState;
  issues: UrgentIssue[];
  summary: string;
  notice: string;
  conversationFound: boolean;
  messageCount: number;
  reason: string;
  elapsedMs: number;
};

const UNAVAILABLE: UrgentVerificationResult = {
  state: "unavailable",
  issues: [],
  summary: "",
  notice: "This lead could not be checked.",
  conversationFound: false,
  messageCount: 0,
  elapsedMs: 0,
  reason: "",
};

// Generous next to the function's own eight second abort on the model call,
// because this covers the whole round trip including the network.
const REQUEST_TIMEOUT_MS = 15_000;

export async function runUrgentVerification(leadId: string): Promise<UrgentVerificationResult> {
  if (!leadId) throw new Error("Missing lead ID.");

  // supabase.functions.invoke has no timeout of its own. The edge function
  // aborts its OpenAI call after eight seconds, but that covers only the model
  // call: DNS, TLS and the hop to Supabase can each stall well past that, and a
  // customer waiting on a dispatch decision should not be left looking at a
  // spinner with no way out. Fifteen seconds is well past the expected one or
  // two, and past anything legitimate.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.functions.invoke("check-urgent-lead", {
      body: { leadId },
      signal: controller.signal,
    } as never);

    if (error) {
      // supabase-js does not put the edge function's body in error.message. It
      // puts the Response in error.context, and error.message is a generic
      // "returned a non-2xx status code". Reading only the message therefore
      // discards whatever the function actually said, which is why a quota
      // failure and a misconfigured key looked identical from here.
      let notice = "";
      let reason = "unknown";
      const context = (error as { context?: unknown }).context;

      if (context && typeof Response !== "undefined" && context instanceof Response) {
        try {
          const body = (await context.clone().json()) as Record<string, unknown>;
          if (typeof body?.error === "string") notice = body.error;
          if (typeof body?.reason === "string") reason = body.reason;
        } catch {
          // A non-JSON body. Nothing to add.
        }
      }

      return {
        ...UNAVAILABLE,
        state: "error",
        reason,
        notice:
          notice ||
          (error.name === "AbortError"
            ? "The check did not respond in time. Check your connection, or mark the lead urgent without a check."
            : error.message || "The check could not be reached. Check your connection and try again."),
      };
    }

    const raw = (data ?? {}) as Record<string, unknown>;
    const verification = raw.verification === "checked" ? "checked" : "unavailable";
    const issues = Array.isArray(raw.issues) ? (raw.issues as UrgentIssue[]) : [];

    return {
      state: verification,
      issues,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      notice: typeof raw.notice === "string" ? raw.notice : "",
      conversationFound: raw.conversation_found === true,
messageCount: typeof raw.message_count === "number" ? raw.message_count : 0,
        reason: "",
        elapsedMs: typeof raw.elapsed_ms === "number" ? raw.elapsed_ms : 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The check found nothing. The database moves the lead to urgent and stamps the
 * activity log.
 */
export async function applyUrgentVerification(leadId: string, summary: string) {
  const { error } = await supabase.rpc("approve_urgent_verification", {
    p_lead_id: leadId,
    p_ai_summary: summary || null,
    p_ai_model: "gpt-4o-mini",
  });

  if (error) throw new Error(error.message);
}

/**
 * Nothing could be verified, and a person has accepted that. Recorded as an
 * acknowledgement so it never reads as a passed check in reporting.
 */
export async function applyUrgentAcknowledgement(leadId: string, reason: string) {
  const { error } = await supabase.rpc("approve_urgent_acknowledgement", {
    p_lead_id: leadId,
    p_reason: reason || null,
  });

  if (error) throw new Error(error.message);
}

/**
 * The check found problems. The lead keeps its current status and waits for a
 * CS Admin.
 */
export async function submitUrgentReviewRequest(input: {
  leadId: string;
  issues: UrgentIssue[];
  summary: string;
  jobId?: string | null;
  customerName?: string | null;
  previousStatus?: string | null;
}) {
  const { data, error } = await supabase.rpc("request_urgent_review", {
    p_lead_id: input.leadId,
    p_ai_issues: input.issues as unknown as Record<string, unknown>[],
    p_ai_summary: input.summary || null,
    p_ai_model: "gpt-4o-mini",
    p_lead_job_id: input.jobId ?? null,
    p_lead_customer_name: input.customerName ?? null,
    p_previous_status: input.previousStatus ?? null,
  });

  if (error) throw new Error(error.message);
  return data as string | null;
}


// =============================================================================
// The review queue.
//
// Only exists when the check found problems. A clean lead never reaches it, and
// a lead that could not be checked never reaches it either, which is the point:
// the queue is a short list of genuine disagreements rather than everything that
// touched an urgent check.
// =============================================================================

export type UrgentReviewStatus = "pending" | "approved" | "declined";

export type UrgentReviewRequest = {
  id: string;
  lead_id: string;
  previous_status: string | null;
  lead_job_id: string | null;
  lead_customer_name: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  ai_issues: UrgentIssue[];
  ai_summary: string | null;
  ai_model: string | null;
  status: UrgentReviewStatus;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  // Live values from the lead, so a reviewer can see what it says now as well
  // as what it said when the request was raised.
  current_status: string | null;
  current_service_details: string | null;
  current_customer_schedule_requirements: string | null;
  current_quote: string | null;
  current_terms: string | null;
};

export async function listUrgentReviewRequests(status: UrgentReviewStatus): Promise<UrgentReviewRequest[]> {
  const { data, error } = await supabase.rpc("list_urgent_review_requests", { p_status: status });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...(row as unknown as UrgentReviewRequest),
    ai_issues: Array.isArray(row.ai_issues) ? (row.ai_issues as UrgentIssue[]) : [],
  }));
}

export async function reviewUrgentRequest(input: {
  requestId: string;
  approve: boolean;
  note?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc("review_urgent_request", {
    p_request_id: input.requestId,
    p_approve: input.approve,
    p_review_note: input.note?.trim() || null,
  });

  if (error) throw new Error(error.message);
  return typeof data === "string" ? data : "Done.";
}

export function canReviewUrgentRequests(role: string | null | undefined): boolean {
  return role === "admin" || role === "cs_admin";
}
