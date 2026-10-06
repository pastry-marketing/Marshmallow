import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } },
}));

import { supabase } from "@/integrations/supabase/client";
import {
  describeSyncStatus,
  fetchSyncHealth,
  formatSyncAge,
  pruneSyncErrorLog,
  retrySyncQueueNow,
} from "./sheets-sync-health";

const rpc = () => vi.mocked(supabase.rpc);

beforeEach(() => {
  vi.clearAllMocks();
});

function healthRow(over: Record<string, unknown> = {}) {
  return {
    status: "healthy",
    last_attempt_at: "2026-11-02T10:00:00Z",
    last_success_at: "2026-11-02T10:00:00Z",
    last_error_at: null,
    last_error_message: null,
    consecutive_failures: 0,
    synced_total: 12,
    queue_depth: 0,
    queue_oldest_at: null,
    queue_oldest_seconds: null,
    failed_jobs: 0,
    seconds_since_success: 30,
    recent_errors: [],
    ...over,
  };
}

describe("fetchSyncHealth", () => {
  it("passes the staleness window to SQL so a dead sync is caught there", async () => {
    rpc().mockResolvedValue({ data: healthRow(), error: null } as never);

    await fetchSyncHealth(600);

    expect(rpc()).toHaveBeenCalledWith("get_sheets_sync_health", { p_stale_after_seconds: 600 });
  });

  it("defaults to fifteen minutes", async () => {
    rpc().mockResolvedValue({ data: healthRow(), error: null } as never);

    await fetchSyncHealth();

    expect(rpc()).toHaveBeenCalledWith("get_sheets_sync_health", {
      p_stale_after_seconds: 900,
    });
  });

  it("returns a typed health object", async () => {
    rpc().mockResolvedValue({ data: healthRow(), error: null } as never);

    const h = await fetchSyncHealth();

    expect(h.status).toBe("healthy");
    expect(h.synced_total).toBe(12);
    expect(h.queue_depth).toBe(0);
    expect(h.seconds_since_success).toBe(30);
  });

  it("reads the single-row array returned by a Postgres RETURNS TABLE RPC", async () => {
    rpc().mockResolvedValue({ data: [healthRow({ status: "degraded", queue_depth: 4111, leads_behind: 4125 })], error: null } as never);

    const h = await fetchSyncHealth();

    expect(h.status).toBe("degraded");
    expect(h.queue_depth).toBe(4111);
    expect(h.leads_behind).toBe(4125);
  });

  it("normalises a null payload into idle rather than throwing", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    const h = await fetchSyncHealth();

    expect(h.status).toBe("idle");
    expect(h.recent_errors).toEqual([]);
    expect(h.consecutive_failures).toBe(0);
  });

  it("coerces numeric strings, since jsonb_agg and bigint can arrive as text", async () => {
    rpc().mockResolvedValue({
      data: healthRow({ consecutive_failures: "3", synced_total: "900", queue_depth: "2" }),
      error: null,
    } as never);

    const h = await fetchSyncHealth();

    expect(h.consecutive_failures).toBe(3);
    expect(h.synced_total).toBe(900);
    expect(h.queue_depth).toBe(2);
  });

  it("keeps a null seconds_since_success as null, not zero", async () => {
    rpc().mockResolvedValue({ data: healthRow({ seconds_since_success: null }), error: null } as never);

    const h = await fetchSyncHealth();

    expect(h.seconds_since_success).toBeNull();
  });

  it("drops malformed entries from recent_errors instead of trusting the shape", async () => {
    rpc().mockResolvedValue({
      data: healthRow({
        recent_errors: [
          { message: "real", action: "sync", occurred_at: "x", lead_id: null },
          { nonsense: true },
          null,
        ],
      }),
      error: null,
    } as never);

    const h = await fetchSyncHealth();

    expect(h.recent_errors).toHaveLength(1);
    expect(h.recent_errors[0].message).toBe("real");
  });

  it("survives a non-array recent_errors", async () => {
    rpc().mockResolvedValue({ data: healthRow({ recent_errors: null }), error: null } as never);

    await expect(fetchSyncHealth()).resolves.toMatchObject({ recent_errors: [] });
  });

  it("throws on an RPC error so the UI can show the failure", async () => {
    rpc().mockResolvedValue({ data: null, error: new Error("boom") } as never);

    await expect(fetchSyncHealth()).rejects.toThrow("boom");
  });
});

describe("retrySyncQueueNow", () => {
  it("invokes the worker so retry means dispatch, not just claim", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { success: true, claimed: 4, processed: 4, acknowledged: 4, failed: 0, queueDepth: 0 },
      error: null,
    } as never);

    await expect(retrySyncQueueNow(40)).resolves.toEqual({
      claimed: 4, processed: 4, acknowledged: 4, failed: 0, queueDepth: 0,
    });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("google-sheets-sync", {
      body: { action: "process_queue", force: true, limit: 40 },
    });
  });

  it("rejects if the server worker does not confirm success", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { success: false, error: "Apps Script timeout" }, error: null,
    } as never);
    await expect(retrySyncQueueNow()).rejects.toThrow("Apps Script timeout");
  });
});

describe("pruneSyncErrorLog", () => {
  it("returns the deleted row count", async () => {
    rpc().mockResolvedValue({ data: 12, error: null } as never);

    await expect(pruneSyncErrorLog(5)).resolves.toBe(12);
    expect(rpc()).toHaveBeenCalledWith("prune_sheets_sync_errors", { p_keep: 5 });
  });
});

describe("backup currency fields", () => {
  it("reports how many leads are behind", async () => {
    rpc().mockResolvedValue({
      data: healthRow({ leads_behind: 37, behind_seconds: 7200, watermark_at: "2026-11-02T09:00:00Z" }),
      error: null,
    } as never);

    const h = await fetchSyncHealth();

    expect(h.leads_behind).toBe(37);
    expect(h.behind_seconds).toBe(7200);
    expect(h.watermark_at).toBe("2026-11-02T09:00:00Z");
  });

  it("keeps leads_behind null when the column does not exist yet", async () => {
    // An unreconciled backup must never render as "0 behind", which would
    // read as fully current when nothing has actually been checked.
    rpc().mockResolvedValue({ data: healthRow(), error: null } as never);

    const h = await fetchSyncHealth();

    expect(h.leads_behind).toBeNull();
    expect(h.behind_seconds).toBeNull();
  });

  it("distinguishes a null count from a real zero", async () => {
    rpc().mockResolvedValue({ data: healthRow({ leads_behind: 0 }), error: null } as never);

    const h = await fetchSyncHealth();

    expect(h.leads_behind).toBe(0);
  });

  it("treats zero behind with no age as current, not stale", async () => {
    rpc().mockResolvedValue({
      data: healthRow({ leads_behind: 0, behind_seconds: null }),
      error: null,
    } as never);

    const h = await fetchSyncHealth();

    expect(h.leads_behind).toBe(0);
    expect(h.behind_seconds).toBeNull();
  });

  it("coerces numeric strings from the jsonb fields", async () => {
    rpc().mockResolvedValue({
      data: healthRow({ leads_behind: "12", behind_seconds: "600" }),
      error: null,
    } as never);

    const h = await fetchSyncHealth();

    expect(h.leads_behind).toBe(12);
    expect(h.behind_seconds).toBe(600);
  });

  it("reports the age of the oldest queued job", async () => {
    rpc().mockResolvedValue({
      data: healthRow({ queue_depth: "4", queue_oldest_seconds: "1200", queue_oldest_at: "2026-11-02T09:00:00Z", failed_jobs: "2" }),
      error: null,
    } as never);
    const h = await fetchSyncHealth();
    expect(h.queue_oldest_seconds).toBe(1200);
    expect(h.queue_oldest_at).toBe("2026-11-02T09:00:00Z");
    expect(h.failed_jobs).toBe(2);
  });
});

describe("formatSyncAge", () => {
  it("says never rather than showing a misleading zero", () => {
    expect(formatSyncAge(null)).toBe("never");
  });

  it("uses seconds below a minute", () => {
    expect(formatSyncAge(42)).toBe("42s ago");
  });

  it("uses minutes below an hour", () => {
    expect(formatSyncAge(600)).toBe("10m ago");
  });

  it("uses hours below a day", () => {
    expect(formatSyncAge(7200)).toBe("2h ago");
  });

  it("uses days beyond that", () => {
    expect(formatSyncAge(172800)).toBe("2d ago");
  });
});

describe("describeSyncStatus", () => {
  it("gives every status a distinct label", () => {
    const labels = (["healthy", "syncing", "degraded", "down", "idle"] as const).map(
      (s) => describeSyncStatus(s).label,
    );
    expect(new Set(labels).size).toBe(5);
  });

  it("uses the destructive token only for down", () => {
    expect(describeSyncStatus("down").tone).toContain("destructive");
    expect(describeSyncStatus("healthy").tone).not.toContain("destructive");
    expect(describeSyncStatus("degraded").tone).not.toContain("destructive");
  });

  it("keeps accent text readable in both themes", () => {
    expect(describeSyncStatus("healthy").tone).toContain("dark:");
    expect(describeSyncStatus("syncing").tone).toContain("dark:");
    expect(describeSyncStatus("degraded").tone).toContain("dark:");
  });
});
