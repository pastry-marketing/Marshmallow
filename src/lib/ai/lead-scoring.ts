import { invokeAi } from "./invoke";

// =============================================================================
// AI Lead Scoring (roadmap Tier 2 / feature 07) — client side.
//
// Suggests a follow-up priority (0-100 + tier) from likely conversion and
// potential value. Advisory: a signal to help order follow-ups — it sets no
// status and changes no field.
// =============================================================================

export type ScoreTier = "hot" | "warm" | "cold";
export type ScoreLevel = "low" | "medium" | "high";

export type LeadScore = {
  score: number;
  tier: ScoreTier;
  conversion: ScoreLevel;
  value: ScoreLevel;
  reasons: string[];
  summary: string;
  conversationFound: boolean;
};

export const TIER_CLASS: Record<ScoreTier, string> = {
  hot: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300",
  warm: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  cold: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-300",
};

export const TIER_LABEL: Record<ScoreTier, string> = {
  hot: "Hot lead",
  warm: "Warm lead",
  cold: "Cold lead",
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseLeadScoring(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

function level(value: unknown): ScoreLevel {
  return value === "high" || value === "medium" ? value : "low";
}

export async function fetchLeadScore(leadId: string): Promise<LeadScore> {
  if (!leadId) throw new Error("Missing lead.");

  const res = await invokeAi<{
    score?: unknown;
    tier?: unknown;
    conversion?: unknown;
    value?: unknown;
    reasons?: unknown;
    summary?: unknown;
    conversation_found?: unknown;
  }>("ai-lead-scoring", { leadId });
  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const score = typeof d.score === "number" ? Math.max(0, Math.min(100, Math.round(d.score))) : 0;
  const tier: ScoreTier = d.tier === "hot" || d.tier === "warm" || d.tier === "cold" ? d.tier : score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";

  return {
    score,
    tier,
    conversion: level(d.conversion),
    value: level(d.value),
    reasons: Array.isArray(d.reasons)
      ? d.reasons.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      : [],
    summary: typeof d.summary === "string" ? d.summary : "",
    conversationFound: d.conversation_found === true,
  };
}
