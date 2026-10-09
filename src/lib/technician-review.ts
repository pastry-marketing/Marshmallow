export type TechnicianReviewState = "not_reviewed" | "unavailable" | "manual_review" | "supported";

/** Missing history is a data-quality state, never a negative technician label. */
export function technicianReviewState(review: {
  reviewed: boolean;
  error?: string | null;
  messages: number;
  suggestedLabels: readonly string[];
}): TechnicianReviewState {
  if (!review.reviewed) return "not_reviewed";
  if (review.error || review.messages === 0) return "unavailable";
  return review.suggestedLabels.length ? "supported" : "manual_review";
}

export const REVIEW_STATES = {
  not_reviewed: { title: "Ready to review", className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  unavailable: { title: "Chat unavailable", className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  manual_review: { title: "Manual review needed", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  supported: { title: "Evidence-backed suggestions", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
} as const;

export function technicianLabelClass(label: string): string {
  if (["good_tech", "paid_us_before"].includes(label)) return "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (["tech_is_scammer", "rude"].includes(label)) return "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300";
  return "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300";
}
