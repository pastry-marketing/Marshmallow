import { invokeAi } from "./invoke";

// =============================================================================
// AI Spam / Scam Detection (roadmap Tier 3 / feature 08) — client side.
//
// Flags suspicious inquiries or unusual conversation patterns for staff review.
// Advisory: it raises a flag with reasons; a person decides.
// =============================================================================

export type SpamVerdict = "legitimate" | "suspicious" | "spam" | "scam";

export type SpamCheck = {
  verdict: SpamVerdict;
  risk: number;
  signals: string[];
  reason: string;
};

export const SPAM_VERDICT_LABEL: Record<SpamVerdict, string> = {
  legitimate: "Looks legitimate",
  suspicious: "Suspicious",
  spam: "Spam",
  scam: "Likely scam",
};

export const SPAM_VERDICT_CLASS: Record<SpamVerdict, string> = {
  legitimate:
    "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  suspicious:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  spam: "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-900/50 dark:bg-orange-950/40 dark:text-orange-300",
  scam: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300",
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseSpamDetection(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

const VERDICTS: SpamVerdict[] = ["legitimate", "suspicious", "spam", "scam"];

export async function fetchSpamCheck(conversationId: string): Promise<SpamCheck> {
  if (!conversationId) throw new Error("Missing conversation.");

  const res = await invokeAi<{
    verdict?: unknown;
    risk?: unknown;
    signals?: unknown;
    reason?: unknown;
  }>("ai-spam-detection", { conversationId });
  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const verdict = VERDICTS.includes(d.verdict as SpamVerdict) ? (d.verdict as SpamVerdict) : "legitimate";
  return {
    verdict,
    risk: typeof d.risk === "number" ? Math.max(0, Math.min(100, Math.round(d.risk))) : 0,
    signals: Array.isArray(d.signals)
      ? d.signals.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [],
    reason: typeof d.reason === "string" ? d.reason : "",
  };
}
