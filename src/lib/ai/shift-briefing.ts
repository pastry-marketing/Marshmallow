import { invokeAi } from "./invoke";

// =============================================================================
// AI Shift Briefing (roadmap Tier 1 / feature 03) — client side.
//
// Asks ai-shift-briefing to summarise the outstanding work (missed calls,
// unanswered texts, urgent leads, open follow-ups) into a short prioritised
// briefing. The counts are computed server-side and trustworthy; the headline
// and ordered priorities are the model's. Advisory — read and act.
// =============================================================================

export type BriefingPriority = {
  title: string;
  detail: string;
  priority: "high" | "medium" | "low";
};

export type ShiftBriefingStats = {
  hoursBack: number;
  missedCalls: number;
  unansweredTexts: number;
  newLeads: number;
  urgentLeads: number;
  followUps: number;
  outstanding: number;
};

export type ShiftBriefing = {
  headline: string;
  priorities: BriefingPriority[];
  stats: ShiftBriefingStats;
  generatedAt: string;
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service"]);

export function canUseShiftBriefing(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function fetchShiftBriefing(hoursBack = 24): Promise<ShiftBriefing> {
  const res = await invokeAi<{
    headline?: unknown;
    priorities?: unknown;
    stats?: Record<string, unknown>;
    generated_at?: unknown;
  }>("ai-shift-briefing", { hoursBack });

  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const rawPriorities = Array.isArray(d.priorities) ? d.priorities : [];
  const priorities: BriefingPriority[] = rawPriorities
    .map((entry) => {
      const p = (entry ?? {}) as Record<string, unknown>;
      const priority = typeof p.priority === "string" ? p.priority : "medium";
      return {
        title: typeof p.title === "string" ? p.title : "",
        detail: typeof p.detail === "string" ? p.detail : "",
        priority: (["high", "medium", "low"].includes(priority) ? priority : "medium") as
          | "high"
          | "medium"
          | "low",
      };
    })
    .filter((p) => p.title);

  const s = d.stats ?? {};
  return {
    headline: typeof d.headline === "string" ? d.headline : "",
    priorities,
    stats: {
      hoursBack: num(s.hours_back) || hoursBack,
      missedCalls: num(s.missed_calls),
      unansweredTexts: num(s.unanswered_texts),
      newLeads: num(s.new_leads),
      urgentLeads: num(s.urgent_leads),
      followUps: num(s.follow_ups),
      outstanding: num(s.outstanding),
    },
    generatedAt: typeof d.generated_at === "string" ? d.generated_at : new Date().toISOString(),
  };
}
