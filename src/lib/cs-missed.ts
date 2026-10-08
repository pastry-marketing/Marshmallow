// Domain logic for the AI Assistance — CS Missed-Lead Tracker.
//
// The heavy lifting (who/what counts as a missed follow-up) lives in the
// `list_cs_missed_followups` SECURITY DEFINER RPC. This module holds the small,
// pure, UI-facing pieces: the row shape, type labels, wait-time formatting and
// the window-preset → Eastern-time bounds used by the page's date filter.

import { getEasternDateBounds } from "@/lib/quo-dashboard";

/** The kind of missed follow-up, as classified by the RPC. */
export type CsMissedType = "missed_call" | "unanswered_text";

/** One row returned by `list_cs_missed_followups`. */
export interface CsMissedFollowup {
  conversation_id: string;
  quo_conversation_id: string | null;
  customer_name: string | null;
  customer_number: string | null;
  number_id: string | null;
  quo_phone_number_id: string | null;
  number: string | null;
  number_name: string | null;
  number_label: string | null;
  number_display: string | null;
  type: CsMissedType;
  is_new_lead: boolean;
  last_customer_at: string | null;
  last_agent_at: string | null;
  waited_minutes: number | null;
  preview: string | null;
  triage_status: string | null;
}

export const CS_MISSED_TYPE_LABELS: Record<CsMissedType, string> = {
  missed_call: "Missed call",
  unanswered_text: "Unanswered text",
};

/** The time windows CS can pick when reviewing the follow-up list. */
export type CsMissedWindow = "last24" | "today" | "yesterday" | "last7" | "all" | "custom";

export const CS_MISSED_WINDOW_LABELS: Record<CsMissedWindow, string> = {
  last24: "Last 24 hours",
  today: "Today (ET)",
  yesterday: "Yesterday (ET)",
  last7: "Last 7 days (ET)",
  all: "All outstanding",
  custom: "Custom range (ET)",
};

/**
 * Turns a window preset into `{ since, until }` ISO strings for the RPC.
 * `since`/`until` are null when that side is unbounded (e.g. "all outstanding"
 * has no lower bound; most presets have no upper bound — the RPC treats a null
 * `until` as "now").
 *
 * Day-based presets (today/yesterday/last7/custom) resolve against the Eastern
 * calendar so they match the rest of the Quo tooling, which is ET-locked.
 */
export function resolveCsMissedWindow(
  window: CsMissedWindow,
  opts: { now?: Date; startDate?: string; endDate?: string } = {},
): { since: string | null; until: string | null } {
  const now = opts.now ?? new Date();

  const easternDayString = (d: Date) =>
    d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD

  switch (window) {
    case "all":
      return { since: null, until: null };

    case "last24":
      return { since: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), until: null };

    case "today": {
      const day = easternDayString(now);
      return {
        since: getEasternDateBounds(day, "start")?.toISOString() ?? null,
        until: getEasternDateBounds(day, "end")?.toISOString() ?? null,
      };
    }

    case "yesterday": {
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const day = easternDayString(y);
      return {
        since: getEasternDateBounds(day, "start")?.toISOString() ?? null,
        until: getEasternDateBounds(day, "end")?.toISOString() ?? null,
      };
    }

    case "last7": {
      const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const day = easternDayString(d7);
      return { since: getEasternDateBounds(day, "start")?.toISOString() ?? null, until: null };
    }

    case "custom": {
      const since = opts.startDate ? getEasternDateBounds(opts.startDate, "start")?.toISOString() ?? null : null;
      const until = opts.endDate ? getEasternDateBounds(opts.endDate, "end")?.toISOString() ?? null : null;
      return { since, until };
    }

    default:
      return { since: null, until: null };
  }
}

/**
 * Compact, human wait time from whole minutes, e.g. 7 → "7m", 95 → "1h 35m",
 * 1500 → "1d 1h". Used for the "waiting" column so CS can triage the oldest
 * misses first at a glance.
 */
export function formatWaited(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return "—";
  const total = Math.floor(minutes);
  if (total < 60) return `${total}m`;

  const hours = Math.floor(total / 60);
  if (hours < 24) {
    const rem = total % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Severity bucket for the wait time, so the UI can escalate colour as a lead
 * goes cold. Boundaries are intentionally simple: under an hour is fresh, a few
 * hours is warm, a shift or more is stale.
 */
export function waitSeverity(minutes: number | null | undefined): "fresh" | "warm" | "stale" {
  if (minutes == null || minutes < 60) return "fresh";
  if (minutes < 8 * 60) return "warm";
  return "stale";
}
