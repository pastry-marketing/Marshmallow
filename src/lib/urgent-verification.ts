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
};

export async function runUrgentVerification(leadId: string): Promise<UrgentVerificationResult> {
  if (!leadId) throw new Error("Missing lead ID.");

  const { data, error } = await supabase.functions.invoke("check-urgent-lead", {
    body: { leadId },
  });

  if (error) {
    // A network failure or a 401/500 is not a pass and not a finding. It is an
    // unknown, and the caller decides what to do about it.
    return {
      ...UNAVAILABLE,
      state: "error",
      notice: error.message || "The check could not be reached. Check your connection and try again.",
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
    elapsedMs: typeof raw.elapsed_ms === "number" ? raw.elapsed_ms : 0,
  };
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

/**
 * Roles the database gate lets straight through.
 *
 * Kept in step with enforce_urgent_gate() in
 * 20261104000000_urgent_review_gate.sql. This is only here to spare those users
 * a pointless dialog; it is not what enforces anything. The trigger is.
 */
export function bypassesUrgentGate(role: string | null | undefined): boolean {
  return role === "admin" || role === "processor" || role === "cs_admin";
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