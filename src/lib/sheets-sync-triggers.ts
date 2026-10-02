/**
 * Which realtime events should cause a lead to be re-synced to the sheet.
 *
 * The sheet row is assembled from three tables, not one. The sync originally
 * listened only to "leads", so a change made purely through a note or a photo
 * never reached the sheet: the CS Notes, Processor Notes, Opr Notes and
 * Pictures columns would sit stale until some unrelated field changed. That
 * was the reason a note edit appeared to do nothing.
 */

/** Bus event names that carry a lead change worth syncing. */
export const SYNC_TRIGGER_EVENTS = ["leads", "lead_notes", "lead_photos"] as const;

export type SyncTriggerEvent = (typeof SYNC_TRIGGER_EVENTS)[number];

/** Tables whose rows are read when building the sheet row. */
export const SHEET_ROW_SOURCES = ["leads", "lead_notes", "lead_photos"] as const;

interface RealtimePayload {
  eventType?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Finds the lead a child-table change belongs to.
 *
 * Checks new before old: on an UPDATE the new row is the useful one, and it is
 * the only one populated on an INSERT.
 *
 * On a DELETE it falls back to old, which only works if the table carries
 * REPLICA IDENTITY FULL. Without that, Postgres sends only the primary key on
 * a delete, so lead_id is genuinely absent and there is nothing to attribute
 * the change to. That is why the migration sets replica identity on these
 * tables rather than leaving it to chance.
 *
 * Returns null rather than guessing when no lead id can be found.
 */
export function leadIdFromChangePayload(payload: unknown): string | null {
  const p = asRecord(payload) as RealtimePayload | null;
  if (!p) return null;

  const fromNew = asRecord(p.new)?.lead_id;
  if (typeof fromNew === "string" && fromNew) return fromNew;

  const fromOld = asRecord(p.old)?.lead_id;
  if (typeof fromOld === "string" && fromOld) return fromOld;

  return null;
}

/**
 * The lead's own id, for events on the leads table itself.
 *
 * Kept separate because a leads event identifies the row by "id" while a child
 * event identifies it by "lead_id", and conflating them is how a note change
 * ends up syncing the wrong lead.
 */
export function leadIdFromLeadPayload(payload: unknown): string | null {
  const p = asRecord(payload) as RealtimePayload | null;
  if (!p) return null;

  const fromNew = asRecord(p.new)?.id;
  if (typeof fromNew === "string" && fromNew) return fromNew;

  const fromOld = asRecord(p.old)?.id;
  if (typeof fromOld === "string" && fromOld) return fromOld;

  return null;
}

/** Job id from whichever side of the change carries it, for delete lookups. */
export function jobIdFromLeadPayload(payload: unknown): string | undefined {
  const p = asRecord(payload) as RealtimePayload | null;
  if (!p) return undefined;

  const fromNew = asRecord(p.new)?.job_id;
  if (typeof fromNew === "string" && fromNew) return fromNew;

  const fromOld = asRecord(p.old)?.job_id;
  if (typeof fromOld === "string" && fromOld) return fromOld;

  return undefined;
}

/** True when the event should be ignored rather than synced. */
export function isIgnorableEvent(eventType: unknown): boolean {
  return eventType !== "INSERT" && eventType !== "UPDATE" && eventType !== "DELETE";
}