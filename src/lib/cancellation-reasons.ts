// The canonical cancellation reason codes the AI may suggest. This mirrors the
// `VALID_REASONS` enum enforced server-side by the `suggest-cancellation-reason`
// edge function (via its strict json_schema) — the edge function remains the
// source of truth; this list exists only so the UI can label and recognise a
// suggested reason from one place.
export const CANCELLATION_REASON_CODES = [
  "Customer Declined Quote",
  "Customer Unreachable",
  "Found Another Provider",
  "Out of Service Area",
  "Duplicate Lead",
  "Job Not Needed",
  "Scheduling Conflict",
  "Other",
] as const;

export type CancellationReasonCode = (typeof CANCELLATION_REASON_CODES)[number];

export function isCancellationReasonCode(value: unknown): value is CancellationReasonCode {
  return typeof value === "string" && (CANCELLATION_REASON_CODES as readonly string[]).includes(value);
}
