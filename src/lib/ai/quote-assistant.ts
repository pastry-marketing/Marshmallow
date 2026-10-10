import { invokeAi } from "./invoke";

// =============================================================================
// AI Quote Assistant (roadmap Tier 2 / feature 05) — client side.
//
// Drafts an estimate range for a lead from comparable past paid jobs plus the
// job description. Advisory: a starting point for a human to review, never a
// final price. The comparable stats are computed server-side from real rows.
// =============================================================================

export type QuoteEstimate = {
  low: number;
  high: number;
  confidence: "low" | "medium" | "high";
  rationale: string;
  caveats: string;
};

export type QuoteComparables = {
  count: number;
  sameAreaCount: number;
  scope: "same_area" | "same_service" | "";
  min: number;
  median: number;
  max: number;
};

export type QuoteAssistantResult = {
  estimate: QuoteEstimate | null;
  comparables: QuoteComparables;
  /** Present when no estimate could be drafted (e.g. no comparables). */
  message: string;
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseQuoteAssistant(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function fetchQuoteEstimate(leadId: string): Promise<QuoteAssistantResult> {
  if (!leadId) throw new Error("Missing lead.");

  const res = await invokeAi<{
    estimate?: Record<string, unknown> | null;
    comparables?: Record<string, unknown>;
    message?: unknown;
  }>("ai-quote-assistant", { leadId });
  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const c = d.comparables ?? {};
  const comparables: QuoteComparables = {
    count: num(c.count),
    sameAreaCount: num(c.same_area_count),
    scope: c.scope === "same_area" || c.scope === "same_service" ? c.scope : "",
    min: num(c.min),
    median: num(c.median),
    max: num(c.max),
  };

  let estimate: QuoteEstimate | null = null;
  if (d.estimate && typeof d.estimate === "object") {
    const e = d.estimate as Record<string, unknown>;
    const confidence = e.confidence === "high" || e.confidence === "medium" ? e.confidence : "low";
    estimate = {
      low: num(e.low),
      high: num(e.high),
      confidence,
      rationale: typeof e.rationale === "string" ? e.rationale : "",
      caveats: typeof e.caveats === "string" ? e.caveats : "",
    };
  }

  return {
    estimate,
    comparables,
    message: typeof d.message === "string" ? d.message : "",
  };
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
