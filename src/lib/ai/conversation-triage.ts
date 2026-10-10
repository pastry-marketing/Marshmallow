import { invokeAi } from "./invoke";

// =============================================================================
// AI Conversation Triage (roadmap Tier 1 / feature 02) — client side.
//
// Suggests a chat status, intent, service type, and urgency for a conversation.
// Advisory: the result is shown to the agent, who decides what to do with it.
// `status` lines up with QuoLeadStatus in quo-dashboard.ts.
// =============================================================================

export type TriageUrgency = "low" | "medium" | "high";

export type ConversationTriage = {
  status: string;
  intent: string;
  serviceType: string;
  urgency: TriageUrgency;
  reason: string;
};

export const TRIAGE_INTENT_LABELS: Record<string, string> = {
  new_job: "New job",
  pricing: "Pricing",
  scheduling: "Scheduling",
  complaint: "Complaint",
  spam: "Spam",
  other: "Other",
};

export const TRIAGE_URGENCY_LABELS: Record<TriageUrgency, string> = {
  low: "Low urgency",
  medium: "Medium urgency",
  high: "High urgency",
};

export const TRIAGE_URGENCY_CLASS: Record<TriageUrgency, string> = {
  low: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  medium: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  high: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300",
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseTriage(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

export async function fetchConversationTriage(conversationId: string): Promise<ConversationTriage> {
  if (!conversationId) throw new Error("Missing conversation.");

  const res = await invokeAi<{
    status?: unknown;
    intent?: unknown;
    service_type?: unknown;
    urgency?: unknown;
    reason?: unknown;
  }>("ai-conversation-triage", { conversationId });

  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const urgency = (["low", "medium", "high"] as const).includes(d.urgency as TriageUrgency)
    ? (d.urgency as TriageUrgency)
    : "low";

  return {
    status: typeof d.status === "string" ? d.status : "raw",
    intent: typeof d.intent === "string" ? d.intent : "other",
    serviceType: typeof d.service_type === "string" ? d.service_type : "",
    urgency,
    reason: typeof d.reason === "string" ? d.reason : "",
  };
}
