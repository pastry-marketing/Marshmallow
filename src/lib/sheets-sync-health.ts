import { supabase } from "@/integrations/supabase/client";

/**
 * Client for the sync health layer in the database.
 *
 * Why this is not a local React state: sync runs in an admin's browser, so
 * anything tracked only in the tab disappears when the tab closes. A tab that
 * stops listening looks exactly like a healthy idle system. Health that lives
 * in the database is still true after everyone has gone home, which is the
 * only version of it that can tell you sync broke.
 *
 * Every function here is admin-only at the database. The grants were revoked
 * from PUBLIC because these are SECURITY DEFINER, so RLS on the tables does
 * not protect them.
 */

export type SyncStatus = "healthy" | "degraded" | "down" | "idle";

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
}

export interface QueuedSyncItem {
  lead_id: string;
  op: "upsert" | "delete";
  job_id: string | null;
  attempts: number;
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

  const row = (data as unknown as Record<string, unknown> | null) ?? {};
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
  };
}

/** Records a successful dispatch. Clears any queued retry for the lead. */
export async function recordSyncSuccess(leadId?: string | null): Promise<void> {
  const { error } = await supabase.rpc("record_sheets_sync_success" as never, {
    p_lead_id: leadId ?? null,
  } as never);
  if (error) throw error;
}

/**
 * Records a failed dispatch. Logs it and queues the lead for retry, so a
 * closed tab cannot discard it.
 *
 * Never throws: health bookkeeping must not turn a recoverable sync failure
 * into a broken sync, and callers are already on an error path.
 */
export async function recordSyncFailure(options: {
  message: string;
  leadId?: string | null;
  action?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await supabase.rpc("record_sheets_sync_failure" as never, {
      p_message: options.message,
      p_lead_id: options.leadId ?? null,
      p_action: options.action ?? "sync",
      p_detail: (options.detail ?? null) as never,
    } as never);
    if (error) throw error;
  } catch {
    // Swallowed deliberately. The failure is already being reported by the
    // caller, and a bookkeeping error must not mask it or retry it.
  }
}

/**
 * Records an outcome without ever rejecting, for the same reason.
 * Success also swallows: a failed heartbeat write should not fail the sync it
 * was describing.
 */
export async function recordSyncOutcome(
  ok: boolean,
  leadId: string | null,
  action: string,
  message?: string,
): Promise<void> {
  if (ok) {
    try {
      await recordSyncSuccess(leadId);
    } catch {
      // ignored
    }
    return;
  }
  await recordSyncFailure({ message: message ?? "Unknown sync failure", leadId, action });
}

/** Claims due retries for this browser session. Respects the backoff window. */
export async function claimSyncQueue(limit = 25): Promise<QueuedSyncItem[]> {
  const { data, error } = await supabase.rpc("claim_sheets_sync_queue" as never, {
    p_limit: limit,
  } as never);
  if (error) throw error;
  return (data as unknown as QueuedSyncItem[]) ?? [];
}

/** Bounds the error log. Call occasionally, not on every failure. */
export async function pruneSyncErrorLog(keep = 500): Promise<number> {
  const { data, error } = await supabase.rpc("prune_sheets_sync_errors" as never, {
    p_keep: keep,
  } as never);
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Raises the stale alert for admins if the sync is degraded or down.
 *
 * The database also does this on a schedule; calling it from the UI means an
 * admin who is already looking at the problem does not have to wait.
 * Throttled server-side to once per 15 minutes.
 */
export async function raiseSyncStaleAlert(
  staleAfterSeconds: number = DEFAULT_STALE_AFTER_SECONDS,
  throttleMinutes = 15,
): Promise<number> {
  const { data, error } = await supabase.rpc("raise_sheets_sync_stale_alert" as never, {
    p_stale_after_seconds: staleAfterSeconds,
    p_throttle_minutes: throttleMinutes,
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
    case "down":
      return { label: "Down", tone: "text-destructive" };
    default:
      return { label: "Idle", tone: "text-muted-foreground" };
  }
}