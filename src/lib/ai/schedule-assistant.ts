import { invokeAi } from "./invoke";

// =============================================================================
// AI Schedule Assistant (roadmap Tier 2 / feature 06) — client side.
//
// Parses a natural-language scheduling request into concrete date/time windows
// and surfaces overdue work and possible technician clashes. Advisory: it
// normalises and warns; the person books.
// =============================================================================

export type ScheduleConfidence = "low" | "medium" | "high";

export type ScheduleWindow = {
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  label: string;
  confidence: ScheduleConfidence;
};

export type ScheduleConflict = {
  customerName: string;
  date: string;
  startTime: string;
  endTime: string;
};

export type ScheduleAssistantResult = {
  windows: ScheduleWindow[];
  overdue: { scheduledDate: string } | null;
  conflicts: ScheduleConflict[];
  todayEastern: string;
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseScheduleAssistant(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

const CONFIDENCES: ScheduleConfidence[] = ["low", "medium", "high"];

export async function fetchScheduleParse(input: {
  leadId?: string;
  text?: string;
}): Promise<ScheduleAssistantResult> {
  const body: Record<string, unknown> = {};
  if (input.leadId) body.leadId = input.leadId;
  if (input.text) body.text = input.text;
  if (Object.keys(body).length === 0) throw new Error("Provide a lead or some text to parse.");

  const res = await invokeAi<{
    windows?: unknown;
    flags?: { overdue?: { scheduled_date?: unknown } | null; conflicts?: unknown };
    today_eastern?: unknown;
  }>("ai-schedule-assistant", body);
  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const rawWindows = Array.isArray(d.windows) ? d.windows : [];
  const windows: ScheduleWindow[] = rawWindows.map((entry) => {
    const w = (entry ?? {}) as Record<string, unknown>;
    const confidence = typeof w.confidence === "string" && CONFIDENCES.includes(w.confidence as ScheduleConfidence)
      ? (w.confidence as ScheduleConfidence)
      : "low";
    return {
      date: typeof w.date === "string" ? w.date : "",
      startTime: typeof w.start_time === "string" ? w.start_time : "",
      endTime: typeof w.end_time === "string" ? w.end_time : "",
      allDay: w.all_day === true,
      label: typeof w.label === "string" ? w.label : "",
      confidence,
    };
  });

  const overdueRaw = d.flags?.overdue ?? null;
  const overdue =
    overdueRaw && typeof overdueRaw.scheduled_date === "string"
      ? { scheduledDate: overdueRaw.scheduled_date }
      : null;

  const rawConflicts = Array.isArray(d.flags?.conflicts) ? d.flags!.conflicts : [];
  const conflicts: ScheduleConflict[] = rawConflicts.map((entry) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    return {
      customerName: typeof c.customer_name === "string" ? c.customer_name : "Another job",
      date: typeof c.date === "string" ? c.date : "",
      startTime: typeof c.start_time === "string" ? c.start_time : "",
      endTime: typeof c.end_time === "string" ? c.end_time : "",
    };
  });

  return {
    windows,
    overdue,
    conflicts,
    todayEastern: typeof d.today_eastern === "string" ? d.today_eastern : "",
  };
}
