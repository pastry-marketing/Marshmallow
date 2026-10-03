import { supabase } from "@/integrations/supabase/client";
import { logActivity } from "@/lib/activity";
import type { AppRole } from "@/types";

/**
 * Client for the technician change approval queue.
 *
 * The queue exists because the pre-existing policy lets a processor UPDATE
 * every column of every technician row, and row level security filters rows
 * rather than columns. A BEFORE UPDATE trigger on technicians now refuses a
 * change to is_good_tech or is_active by anyone but an admin, so these RPCs are
 * the only route to those two columns for a processor.
 *
 * Every function here goes through the database rather than updating the table
 * directly. A direct client write is not merely discouraged, it is rejected.
 */

export type TechnicianChangeType = "set_good_tech" | "set_active";
export type TechnicianChangeDecision = "approved" | "declined";
export type TechnicianChangeStatus = "pending" | TechnicianChangeDecision;

export interface TechnicianChangeRequest {
  id: string;
  technician_id: string;
  technician_name: string;
  change_type: TechnicianChangeType;
  requested_value: boolean;
  previous_value: boolean | null;
  reason: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  status: TechnicianChangeStatus;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  /** Live technician values, so a stale queue shows the drift. */
  current_is_good_tech: boolean | null;
  current_is_active: boolean | null;
}

export interface PendingChangeSummary {
  technician_id: string;
  technician_name: string;
  change_types: TechnicianChangeType[];
}

type RpcResult = { data: unknown; error: { message: string } | null };

function rpc(name: string, args?: Record<string, unknown>) {
  return supabase.rpc(name as never, (args ?? {}) as never) as unknown as Promise<RpcResult>;
}

/** Only processors raise requests; only admins review them. Admins also write the flags directly. */
export function canRequestTechnicianChange(role: AppRole | null | undefined): boolean {
  return role === "processor" || role === "admin";
}

export function canReviewTechnicianChanges(role: AppRole | null | undefined): boolean {
  return role === "admin";
}

export function isTechnicianChangeType(value: unknown): value is TechnicianChangeType {
  return value === "set_good_tech" || value === "set_active";
}

/**
 * "Good Tech" reads better than set_good_tech in the UI, and an operator should
 * not have to remember which token maps to which column.
 */
export function describeChangeType(changeType: TechnicianChangeType): {
  label: string;
  column: string;
} {
  return changeType === "set_good_tech"
    ? { label: "Good Tech", column: "is_good_tech" }
    : { label: "Active status", column: "is_active" };
}

/**
 * True when the flag already holds the requested value, which means the
 * request would be a no-op and the database rejects it. Checked here so the UI
 * can grey the control out rather than letting the user press a button that is
 * guaranteed to fail.
 */
export function isAlreadyApplied(
  request: Pick<TechnicianChangeRequest, "change_type" | "requested_value" | "previous_value">,
  currentGoodTech: boolean | null | undefined,
  currentActive: boolean | null | undefined,
): boolean {
  const current =
    request.change_type === "set_good_tech"
      ? (currentGoodTech ?? false)
      : (currentActive ?? true);
  return current === request.requested_value;
}

/**
 * A pending request can be withdrawn when the flag has not already drifted to
 * the requested value on its own, which would make the approval meaningless.
 */
export function isWithdrawn(
  request: Pick<TechnicianChangeRequest, "change_type" | "requested_value" | "previous_value">,
  currentGoodTech: boolean | null | undefined,
  currentActive: boolean | null | undefined,
): boolean {
  return isAlreadyApplied(request, currentGoodTech, currentActive);
}

export async function requestTechnicianChange(args: {
  technicianId: string;
  technicianName: string;
  changeType: TechnicianChangeType;
  requestedValue: boolean;
  reason?: string | null;
  requesterId: string;
}): Promise<string> {
  const { data, error } = await rpc("request_technician_change", {
    p_technician_id: args.technicianId,
    p_change_type: args.changeType,
    p_requested_value: args.requestedValue,
    p_reason: args.reason ?? null,
  });
  if (error) throw new Error(error.message);

  const requestId = typeof data === "string" ? data : String(data ?? "");

  // Activity logging must never fail the request: the queue row is already
  // written and notifying the admin matters more than an audit entry.
  try {
    await logActivity(
      args.requesterId,
      "technician_change_requested",
      "technician",
      args.technicianId,
      {
        target_name: args.technicianName,
        change_type: args.changeType,
        requested_value: args.requestedValue,
      },
    );
  } catch (activityError) {
    console.warn(
      "Technician change was requested, but activity logging failed",
      activityError,
    );
  }

  return requestId;
}

export async function reviewTechnicianChange(args: {
  requestId: string;
  approve: boolean;
  note?: string | null;
  reviewerId: string;
}): Promise<string> {
  const { data, error } = await rpc("review_technician_change", {
    p_request_id: args.requestId,
    p_approve: args.approve,
    p_note: args.note ?? null,
  });
  if (error) throw new Error(error.message);
  return typeof data === "string" ? data : String(data ?? "");
}

export async function withdrawTechnicianChange(
  requestId: string,
): Promise<void> {
  const { error } = await rpc("withdraw_technician_change", {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
}

export async function listTechnicianChangeRequests(
  status: TechnicianChangeStatus = "pending",
): Promise<TechnicianChangeRequest[]> {
  const { data, error } = await rpc("list_technician_change_requests", {
    p_status: status,
  });
  if (error) throw new Error(error.message);
  return (data as TechnicianChangeRequest[]) ?? [];
}

export async function fetchPendingChangeSummary(): Promise<
  Record<string, PendingChangeSummary>
> {
  const { data, error } = await rpc("pending_technician_change_summary");
  if (error) throw new Error(error.message);

  const rows = (data as PendingChangeSummary[]) ?? [];
  const map: Record<string, PendingChangeSummary> = {};
  rows.forEach((row) => {
    if (row?.technician_id) map[row.technician_id] = row;
  });
  return map;
}