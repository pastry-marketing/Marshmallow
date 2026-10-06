import { supabase } from "@/integrations/supabase/client";

/**
 * Client for the sync health layer in the database.
 *
 * Delivery is owned by a transactional database outbox and scheduled Edge
 * worker, so health/retries continue when every browser is closed.
 *
 * Every function here is admin-only at the database. The grants were revoked
 * from PUBLIC because these are SECURITY DEFINER, so RLS on the tables does
 * not protect them.
 */

export type SyncStatus = "healthy" | "syncing" | "degraded" | "down" | "idle";

export interface SyncErrorEntry {
  occurred_at: string;
  message: string;
  action: string;
  lead_id: string | null;
}

export interface SyncHealth {
  status: SyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  consecutive_failures: number;
  synced_total: number;
  queue_depth: number;
  seconds_since_success: number | null;
  recent_errors: SyncErrorEntry[];
  /**
   * How many leads changed after the watermark, i.e. how many records the
   * backup is actually missing. Null on databases that have not applied the
   * watermark migration yet.
   *
   * This is the number that matters for a backup. Wall-clock freshness would
   * report an idle system as stale and a system with three thousand unsynced
   * leads as fresh if anything had synced in the last fifteen minutes.
   */
  leads_behind: number | null;
  behind_seconds: number | null;
  watermark_at: string | null;
  queue_oldest_at: string | null;
  queue_oldest_seconds: number | null;
  failed_jobs: number;
}

const DEFAULT_STALE_AFTER_SECONDS = 900; // 15 minutes

function normaliseErrors(value: unknown): SyncErrorEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is SyncErrorEntry =>
      !!e && typeof e === "object" && typeof (e as SyncErrorEntry).message === "string",
  );
}

/**
 * Reads the current status.
 *
 * `staleAfterSeconds` decides how old the last success has to be before the
 * status degrades. It is applied in SQL, so a sync that stopped without
 * recording anything still reports as degraded rather than healthy.
 */
export async function fetchSyncHealth(
  staleAfterSeconds: number = DEFAULT_STALE_AFTER_SECONDS,
): Promise<SyncHealth> {
  const { data, error } = await supabase.rpc("get_sheets_sync_health" as never, {
    p_stale_after_seconds: staleAfterSeconds,
  } as never);

  if (error) throw error;

  // Postgres functions declared RETURNS TABLE are serialized by PostgREST as
  // a one-row array. Accept an object too for older functions and unit mocks.
  const payload = data && Array.isArray(data) ? data[0] : data;
  const row = (payload as unknown as Record<string, unknown> | null) ?? {};
  return {
    status: (row.status as SyncStatus) ?? "idle",
    last_attempt_at: (row.last_attempt_at as string | null) ?? null,
    last_success_at: (row.last_success_at as string | null) ?? null,
    last_error_at: (row.last_error_at as string | null) ?? null,
    last_error_message: (row.last_error_message as string | null) ?? null,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    synced_total: Number(row.synced_total ?? 0),
    queue_depth: Number(row.queue_depth ?? 0),
    seconds_since_success:
      row.seconds_since_success === null || row.seconds_since_success === undefined
        ? null
        : Number(row.seconds_since_success),
    recent_errors: normaliseErrors(row.recent_errors),
    // Absent rather than zero when the watermark columns do not exist yet, so
    // an unreconciled backup is never mistaken for a current one.
    leads_behind:
      row.leads_behind === null || row.leads_behind === undefined
        ? null
        : Number(row.leads_behind),
    behind_seconds:
      row.behind_seconds === null || row.behind_seconds === undefined
        ? null
        : Number(row.behind_seconds),
    watermark_at: (row.watermark_at as string | null) ?? null,
    queue_oldest_at: (row.queue_oldest_at as string | null) ?? null,
    queue_oldest_seconds:
      row.queue_oldest_seconds === null || row.queue_oldest_seconds === undefined
        ? null
        : Number(row.queue_oldest_seconds),
    failed_jobs: Number(row.failed_jobs ?? 0),
  };
}

/** Ask the server worker to retry queued jobs now; claiming alone is not a retry. */
export async function retrySyncQueueNow(limit = 50): Promise<{
  claimed: number;
  processed: number;
  acknowledged: number;
  failed: number;
  queueDepth: number;
}> {
  const { data, error } = await supabase.functions.invoke("google-sheets-sync", {
    body: { action: "process_queue", force: true, limit },
  });
  if (error) throw new Error(error.message || "Could not start the Google Sheets retry worker.");
  if (!data || data.success !== true) {
    throw new Error(String(data?.error || "The Google Sheets retry worker did not confirm completion."));
  }
  return {
    claimed: Number(data.claimed ?? 0),
    processed: Number(data.processed ?? 0),
    acknowledged: Number(data.acknowledged ?? 0),
    failed: Number(data.failed ?? 0),
    queueDepth: Number(data.queueDepth ?? 0),
  };
}

/** Bounds the error log. Call occasionally, not on every failure. */
export async function pruneSyncErrorLog(keep = 500): Promise<number> {
  const { data, error } = await supabase.rpc("prune_sheets_sync_errors" as never, {
    p_keep: keep,
  } as never);
  if (error) throw error;
  return Number(data ?? 0);
}

/** Human-readable age, so the UI does not each invent its own wording. */
export function formatSyncAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** One label per status, used by both the badge and the banner. */
export function describeSyncStatus(status: SyncStatus): { label: string; tone: string } {
  switch (status) {
    case "healthy":
      return { label: "Healthy", tone: "text-emerald-600 dark:text-emerald-400" };
    case "degraded":
      return { label: "Degraded", tone: "text-amber-600 dark:text-amber-400" };
    case "syncing":
      return { label: "Syncing", tone: "text-sky-600 dark:text-sky-400" };
    case "down":
      return { label: "Down", tone: "text-destructive" };
    default:
      return { label: "Idle", tone: "text-muted-foreground" };
  }
}
