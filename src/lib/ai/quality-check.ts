import { invokeAi } from "./invoke";

// =============================================================================
// AI Quality Checking (roadmap Tier 3 / feature 10) — client side.
//
// Reviews a staff member's DRAFT reply before sending — tone, missing info,
// policy, accuracy, clarity, grammar — against the conversation, and offers an
// improved version. Advisory: it suggests; the agent edits and sends. It never
// sends and never blocks.
// =============================================================================

export type QualityVerdict = "good" | "minor" | "revise";
export type QualityCategory = "tone" | "missing_info" | "policy" | "accuracy" | "clarity" | "grammar";
export type QualitySeverity = "low" | "medium" | "high";

export type QualityIssue = {
  category: QualityCategory;
  severity: QualitySeverity;
  note: string;
};

export type QualityCheckResult = {
  verdict: QualityVerdict;
  issues: QualityIssue[];
  improved: string;
};

export const QUALITY_VERDICT_LABEL: Record<QualityVerdict, string> = {
  good: "Looks good to send",
  minor: "Minor suggestions",
  revise: "Consider revising",
};

export const QUALITY_VERDICT_CLASS: Record<QualityVerdict, string> = {
  good: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  minor:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  revise:
    "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300",
};

export const QUALITY_CATEGORY_LABEL: Record<QualityCategory, string> = {
  tone: "Tone",
  missing_info: "Missing info",
  policy: "Policy",
  accuracy: "Accuracy",
  clarity: "Clarity",
  grammar: "Grammar",
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseQualityCheck(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

const CATEGORIES: QualityCategory[] = ["tone", "missing_info", "policy", "accuracy", "clarity", "grammar"];
const SEVERITIES: QualitySeverity[] = ["low", "medium", "high"];
const VERDICTS: QualityVerdict[] = ["good", "minor", "revise"];

export async function fetchQualityCheck(conversationId: string, draft: string): Promise<QualityCheckResult> {
  if (!conversationId) throw new Error("Missing conversation.");
  if (!draft.trim()) throw new Error("There is no draft reply to check.");

  const res = await invokeAi<{ verdict?: unknown; issues?: unknown; improved?: unknown }>(
    "ai-quality-check",
    { conversationId, draft },
  );
  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const verdict = VERDICTS.includes(d.verdict as QualityVerdict) ? (d.verdict as QualityVerdict) : "good";
  const rawIssues = Array.isArray(d.issues) ? d.issues : [];
  const issues: QualityIssue[] = rawIssues
    .map((entry) => {
      const it = (entry ?? {}) as Record<string, unknown>;
      return {
        category: CATEGORIES.includes(it.category as QualityCategory)
          ? (it.category as QualityCategory)
          : "clarity",
        severity: SEVERITIES.includes(it.severity as QualitySeverity)
          ? (it.severity as QualitySeverity)
          : "low",
        note: typeof it.note === "string" ? it.note : "",
      };
    })
    .filter((it) => it.note);

  return {
    verdict,
    issues,
    improved: typeof d.improved === "string" ? d.improved.trim() : "",
  };
}
