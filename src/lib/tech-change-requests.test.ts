import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));

import { supabase } from "@/integrations/supabase/client";
import { logActivity } from "@/lib/activity";
import {
  canRequestTechnicianChange,
  canReviewTechnicianChanges,
  describeChangeType,
  fetchPendingChangeSummary,
  isAlreadyApplied,
  isTechnicianChangeType,
  listTechnicianChangeRequests,
  requestTechnicianChange,
  reviewTechnicianChange,
  withdrawTechnicianChange,
  type TechnicianChangeRequest,
} from "./tech-change-requests";

const rpc = () => vi.mocked(supabase.rpc);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logActivity).mockResolvedValue(undefined);
});

function row(over: Partial<TechnicianChangeRequest> = {}): TechnicianChangeRequest {
  return {
    id: "r1",
    technician_id: "t1",
    technician_name: "Marcus Webb",
    change_type: "set_good_tech",
    requested_value: true,
    previous_value: false,
    reason: null,
    requested_by: "u1",
    requested_by_name: "Dana Cruz",
    status: "pending",
    reviewed_by_name: null,
    reviewed_at: null,
    review_note: null,
    created_at: "2026-11-03T10:00:00Z",
    current_is_good_tech: false,
    current_is_active: true,
    ...over,
  };
}

describe("permissions", () => {
  it("lets only processor and admin raise a request", () => {
    expect(canRequestTechnicianChange("processor")).toBe(true);
    expect(canRequestTechnicianChange("admin")).toBe(true);
    expect(canRequestTechnicianChange("cs_admin")).toBe(false);
    expect(canRequestTechnicianChange("customer_service")).toBe(false);
    expect(canRequestTechnicianChange("opr")).toBe(false);
    expect(canRequestTechnicianChange("opr_admin")).toBe(false);
    expect(canRequestTechnicianChange(null)).toBe(false);
  });

  it("lets only admin review", () => {
    expect(canReviewTechnicianChanges("admin")).toBe(true);
    expect(canReviewTechnicianChanges("processor")).toBe(false);
    expect(canReviewTechnicianChanges("cs_admin")).toBe(false);
    expect(canReviewTechnicianChanges(null)).toBe(false);
  });
});

describe("isTechnicianChangeType", () => {
  it("accepts the two real types", () => {
    expect(isTechnicianChangeType("set_good_tech")).toBe(true);
    expect(isTechnicianChangeType("set_active")).toBe(true);
  });

  it("rejects anything else so a typo cannot reach the RPC", () => {
    expect(isTechnicianChangeType("set_goodtech")).toBe(false);
    expect(isTechnicianChangeType("")).toBe(false);
    expect(isTechnicianChangeType(null)).toBe(false);
    expect(isTechnicianChangeType(undefined)).toBe(false);
  });
});

describe("describeChangeType", () => {
  it("names the human label and the real column", () => {
    expect(describeChangeType("set_good_tech")).toEqual({
      label: "Good Tech",
      column: "is_good_tech",
    });
    expect(describeChangeType("set_active")).toEqual({
      label: "Active status",
      column: "is_active",
    });
  });
});

describe("isAlreadyApplied", () => {
  it("detects a good-tech request that the row already satisfies", () => {
    expect(isAlreadyApplied(row({ requested_value: true }), true, true)).toBe(true);
    expect(isAlreadyApplied(row({ requested_value: true }), false, true)).toBe(false);
  });

  it("reads the matching column per change type", () => {
    const active = row({ change_type: "set_active", requested_value: false });
    // is_active is already false, so this is a no-op regardless of good tech.
    expect(isAlreadyApplied(active, true, false)).toBe(true);
    expect(isAlreadyApplied(active, true, true)).toBe(false);
  });

  it("treats a null is_good_tech as false", () => {
    expect(isAlreadyApplied(row({ requested_value: false }), null, true)).toBe(true);
    expect(isAlreadyApplied(row({ requested_value: true }), null, true)).toBe(false);
  });

  it("treats a missing is_active as active", () => {
    const active = row({ change_type: "set_active", requested_value: true });
    expect(isAlreadyApplied(active, false, null)).toBe(true);
    expect(isAlreadyApplied(active, false, false)).toBe(false);
  });
});

describe("requestTechnicianChange", () => {
  it("sends the technician, type and value to the RPC", async () => {
    rpc().mockResolvedValue({ data: "req-1", error: null } as never);

    const id = await requestTechnicianChange({
      technicianId: "t1",
      technicianName: "Marcus Webb",
      changeType: "set_good_tech",
      requestedValue: true,
      reason: "consistently excellent on urgent jobs",
      requesterId: "u1",
    });

    expect(rpc()).toHaveBeenCalledWith("request_technician_change", {
      p_technician_id: "t1",
      p_change_type: "set_good_tech",
      p_requested_value: true,
      p_reason: "consistently excellent on urgent jobs",
    });
    expect(id).toBe("req-1");
  });

  it("defaults the reason to null rather than sending undefined", async () => {
    rpc().mockResolvedValue({ data: "req-1", error: null } as never);

    await requestTechnicianChange({
      technicianId: "t1",
      technicianName: "Marcus Webb",
      changeType: "set_active",
      requestedValue: false,
      requesterId: "u1",
    });

    expect(vi.mocked(supabase.rpc).mock.calls[0][1]).toMatchObject({ p_reason: null });
  });

  it("logs the request to the activity trail", async () => {
    rpc().mockResolvedValue({ data: "req-1", error: null } as never);

    await requestTechnicianChange({
      technicianId: "t1",
      technicianName: "Marcus Webb",
      changeType: "set_good_tech",
      requestedValue: true,
      requesterId: "u1",
    });

    expect(logActivity).toHaveBeenCalledWith(
      "u1",
      "technician_change_requested",
      "technician",
      "t1",
      expect.objectContaining({ target_name: "Marcus Webb", change_type: "set_good_tech" }),
    );
  });

  it("still returns the id when activity logging fails", async () => {
    rpc().mockResolvedValue({ data: "req-1", error: null } as never);
    vi.mocked(logActivity).mockRejectedValue(new Error("audit down"));

    await expect(
      requestTechnicianChange({
        technicianId: "t1",
        technicianName: "Marcus Webb",
        changeType: "set_good_tech",
        requestedValue: true,
        requesterId: "u1",
      }),
    ).resolves.toBe("req-1");
  });

  it("surfaces the database rejection, such as a duplicate pending request", async () => {
    rpc().mockResolvedValue({ data: null, error: { message: "already awaiting approval" } } as never);

    await expect(
      requestTechnicianChange({
        technicianId: "t1",
        technicianName: "Marcus Webb",
        changeType: "set_good_tech",
        requestedValue: true,
        requesterId: "u1",
      }),
    ).rejects.toThrow("already awaiting approval");
  });
});

describe("reviewTechnicianChange", () => {
  it("sends the decision and returns the human message", async () => {
    rpc().mockResolvedValue({ data: "Approved.", error: null } as never);

    const message = await reviewTechnicianChange({
      requestId: "r1",
      approve: true,
      note: "verified",
      reviewerId: "admin1",
    });

    expect(rpc()).toHaveBeenCalledWith("review_technician_change", {
      p_request_id: "r1",
      p_approve: true,
      p_note: "verified",
    });
    expect(message).toBe("Approved.");
  });

  it("passes false for a decline rather than omitting the argument", async () => {
    rpc().mockResolvedValue({ data: "Declined.", error: null } as never);

    await reviewTechnicianChange({ requestId: "r1", approve: false, reviewerId: "a1" });

    expect(vi.mocked(supabase.rpc).mock.calls[0][1]).toMatchObject({ p_approve: false });
  });

  it("throws when a non-admin tries, from the database not the client", async () => {
    rpc().mockResolvedValue({ data: null, error: { message: "Only an admin may review" } } as never);

    await expect(
      reviewTechnicianChange({ requestId: "r1", approve: true, reviewerId: "proc1" }),
    ).rejects.toThrow("Only an admin may review");
  });
});

describe("withdrawTechnicianChange", () => {
  it("sends the request id", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await withdrawTechnicianChange("r1");

    expect(rpc()).toHaveBeenCalledWith("withdraw_technician_change", { p_request_id: "r1" });
  });

  it("throws when the row is not pending any more", async () => {
    rpc().mockResolvedValue({ data: null, error: { message: "already approved" } } as never);

    await expect(withdrawTechnicianChange("r1")).rejects.toThrow("already approved");
  });
});

describe("listTechnicianChangeRequests", () => {
  it("defaults to pending", async () => {
    rpc().mockResolvedValue({ data: [row()], error: null } as never);

    const rows = await listTechnicianChangeRequests();

    expect(rpc()).toHaveBeenCalledWith("list_technician_change_requests", { p_status: "pending" });
    expect(rows).toHaveLength(1);
  });

  it("can ask for a decided status", async () => {
    rpc().mockResolvedValue({ data: [], error: null } as never);

    await listTechnicianChangeRequests("approved");

    expect(rpc()).toHaveBeenCalledWith("list_technician_change_requests", { p_status: "approved" });
  });

  it("carries the live technician values so drift is visible", async () => {
    rpc().mockResolvedValue({ data: [row({ current_is_active: false })], error: null } as never);

    const rows = await listTechnicianChangeRequests();

    expect(rows[0].current_is_active).toBe(false);
  });

  it("returns an empty list rather than throwing on no rows", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await expect(listTechnicianChangeRequests()).resolves.toEqual([]);
  });
});

describe("fetchPendingChangeSummary", () => {
  it("keys the summary by technician id", async () => {
    rpc().mockResolvedValue({
      data: [
        { technician_id: "t1", technician_name: "Marcus Webb", change_types: ["set_good_tech"] },
      ],
      error: null,
    } as never);

    const map = await fetchPendingChangeSummary();

    expect(Object.keys(map)).toEqual(["t1"]);
    expect(map.t1.change_types).toEqual(["set_good_tech"]);
  });

  it("returns an empty map when nothing is pending", async () => {
    rpc().mockResolvedValue({ data: null, error: null } as never);

    await expect(fetchPendingChangeSummary()).resolves.toEqual({});
  });
});