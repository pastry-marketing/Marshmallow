import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from "@/integrations/supabase/client";
import {
  claimSyncQueue,
  describeSyncStatus,
  fetchSyncHealth,
  formatSyncAge,
  pruneSyncErrorLog,
  raiseSyncStaleAlert,
  recordSyncFailure,
  recordSyncOutcome,
  recordSyncSuccess,
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

describe("recordSyncSuccess", () => {
  it("sends a null lead id when the dispatch was not lead-specific", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await recordSyncSuccess();

    expect(rpc()).toHaveBeenCalledWith("record_sheets_sync_success", { p_lead_id: null });
  });

  it("passes the lead so a queued retry is cleared", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await recordSyncSuccess("lead-1");

    expect(rpc()).toHaveBeenCalledWith("record_sheets_sync_success", { p_lead_id: "lead-1" });
  });
});

describe("recordSyncFailure", () => {
  it("sends the lead id so the database can queue it for retry", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await recordSyncFailure({ message: "quota exceeded", leadId: "lead-1", action: "upsert" });

    expect(rpc()).toHaveBeenCalledWith("record_sheets_sync_failure", {
      p_message: "quota exceeded",
      p_lead_id: "lead-1",
      p_action: "upsert",
      p_detail: null,
    });
  });

  it("defaults the action so a caller cannot accidentally omit it", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await recordSyncFailure({ message: "boom" });

    expect(rpc()).toHaveBeenCalledWith("record_sheets_sync_failure", expect.objectContaining({
      p_action: "sync",
    }));
  });

  it("never rejects, because it runs while already handling a failure", async () => {
    rpc().mockResolvedValue({ data: null, error: new Error("db down") } as never);

    await expect(recordSyncFailure({ message: "boom" })).resolves.toBeUndefined();
  });

  it("never rejects when rpc itself throws", async () => {
    rpc().mockRejectedValue(new Error("network"));

    await expect(recordSyncFailure({ message: "boom" })).resolves.toBeUndefined();
  });
});

describe("recordSyncOutcome", () => {
  it("records success", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await recordSyncOutcome(true, "lead-1", "upsert");

    expect(rpc()).toHaveBeenCalledWith("record_sheets_sync_success", { p_lead_id: "lead-1" });
  });

  it("records failure with the supplied message", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await recordSyncOutcome(false, "lead-1", "upsert", "Apps Script said no");

    expect(rpc()).toHaveBeenCalledWith("record_sheets_sync_failure", expect.objectContaining({
      p_message: "Apps Script said no",
      p_lead_id: "lead-1",
    }));
  });

  it("supplies a message rather than sending an empty one", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await recordSyncOutcome(false, null, "sync");

    expect(rpc()).toHaveBeenCalledWith("record_sheets_sync_failure", expect.objectContaining({
      p_message: expect.any(String),
    }));
  });

  it("does not reject when the success heartbeat write fails", async () => {
    rpc().mockResolvedValue({ data: null, error: new Error("db down") } as never);

    await expect(recordSyncOutcome(true, "lead-1", "upsert")).resolves.toBeUndefined();
  });

  it("does not reject when the failure write fails either", async () => {
    rpc().mockRejectedValue(new Error("network"));

    await expect(recordSyncOutcome(false, "lead-1", "upsert", "x")).resolves.toBeUndefined();
  });
});

describe("claimSyncQueue", () => {
  it("returns the claimed rows", async () => {
    rpc().mockResolvedValue({
      data: [{ lead_id: "l1", op: "upsert", job_id: null, attempts: 1 }],
      error: null,
    } as never);

    const rows = await claimSyncQueue(10);

    expect(rpc()).toHaveBeenCalledWith("claim_sheets_sync_queue", { p_limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].lead_id).toBe("l1");
  });

  it("returns an empty list when there is nothing due", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await expect(claimSyncQueue()).resolves.toEqual([]);
  });
});

describe("pruneSyncErrorLog", () => {
  it("returns the deleted row count", async () => {
    rpc().mockResolvedValue({ data: 12, error: null } as never);

    await expect(pruneSyncErrorLog(5)).resolves.toBe(12);
    expect(rpc()).toHaveBeenCalledWith("prune_sheets_sync_errors", { p_keep: 5 });
  });
});

describe("raiseSyncStaleAlert", () => {
  it("returns how many admins were alerted", async () => {
    rpc().mockResolvedValue({ data: 2, error: null } as never);

    await expect(raiseSyncStaleAlert()).resolves.toBe(2);
    expect(rpc()).toHaveBeenCalledWith("raise_sheets_sync_stale_alert", {
      p_stale_after_seconds: 900,
      p_throttle_minutes: 15,
    });
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
    const labels = (["healthy", "degraded", "down", "idle"] as const).map(
      (s) => describeSyncStatus(s).label,
    );
    expect(new Set(labels).size).toBe(4);
  });

  it("uses the destructive token only for down", () => {
    expect(describeSyncStatus("down").tone).toContain("destructive");
    expect(describeSyncStatus("healthy").tone).not.toContain("destructive");
    expect(describeSyncStatus("degraded").tone).not.toContain("destructive");
  });

  it("keeps accent text readable in both themes", () => {
    expect(describeSyncStatus("healthy").tone).toContain("dark:");
    expect(describeSyncStatus("degraded").tone).toContain("dark:");
  });
});