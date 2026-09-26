import { supabase } from "@/integrations/supabase/client";
import { logActivity } from "@/lib/activity";
import type { AppRole, Lead, LeadStatus } from "@/types";

export type QuoteApprovalDecision = "approved" | "declined";
export type QuoteApprovalRequestStatus = "pending" | QuoteApprovalDecision;

export interface LeadQuoteApprovalRequest {
  id: string;
  lead_id: string;
  previous_status: LeadStatus;
  lead_job_id: string | null;
  lead_customer_name: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  status: QuoteApprovalRequestStatus;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

type RequestArgs = {
  lead: Pick<Lead, "id" | "job_id" | "customer_name" | "status">;
  requesterId: string;
};

type ReviewArgs = {
  request: LeadQuoteApprovalRequest;
  reviewerId: string;
  decision: QuoteApprovalDecision;
  reviewNote?: string | null;
};

const rpc = supabase.rpc as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export function canReviewQuoteApproval(role: AppRole | null | undefined) {
  return role === "admin" || role === "cs_admin";
}

export async function requestQuoteApproval({ lead, requesterId }: RequestArgs) {
  const { data, error } = await rpc("request_quote_approval", { _lead_id: lead.id });
  if (error) throw new Error(error.message);

  try {
    await logActivity(requesterId, "quote_approval_requested", "lead", lead.id, {
      target_name: lead.job_id,
      customer_name: lead.customer_name,
      job_id: lead.job_id,
      status_from: lead.status,
      requested_status: "pending_to_send",
    });
  } catch (activityError) {
    console.warn("Quote approval was requested, but activity logging failed", activityError);
  }

  return data as string;
}

export async function reviewQuoteApproval({
  request,
  reviewerId,
  decision,
  reviewNote,
}: ReviewArgs) {
  const { error } = await rpc("review_quote_approval_request", {
    _request_id: request.id,
    _decision: decision,
    _review_note: reviewNote?.trim() || null,
  });
  if (error) throw new Error(error.message);

  try {
    await logActivity(
      reviewerId,
      decision === "approved" ? "quote_approval_approved" : "quote_approval_declined",
      "lead",
      request.lead_id,
      {
        target_name: request.lead_job_id || request.lead_id,
        customer_name: request.lead_customer_name,
        job_id: request.lead_job_id,
        requested_by: request.requested_by,
        review_note: reviewNote?.trim() || null,
        status_from: request.previous_status,
        status_to: decision === "approved" ? "pending_to_send" : request.previous_status,
      },
    );
  } catch (activityError) {
    console.warn("Quote approval was reviewed, but activity logging failed", activityError);
  }
}
