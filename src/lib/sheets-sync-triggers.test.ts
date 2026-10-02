import { describe, expect, it } from "vitest";
import {
  SYNC_TRIGGER_EVENTS,
  isIgnorableEvent,
  jobIdFromLeadPayload,
  leadIdFromChangePayload,
  leadIdFromLeadPayload,
} from "./sheets-sync-triggers";

describe("SYNC_TRIGGER_EVENTS", () => {
  it("covers all three tables the sheet row is built from", () => {
    expect(SYNC_TRIGGER_EVENTS).toContain("leads");
    expect(SYNC_TRIGGER_EVENTS).toContain("lead_notes");
    expect(SYNC_TRIGGER_EVENTS).toContain("lead_photos");
  });
});

describe("leadIdFromChangePayload", () => {
  it("reads lead_id from an insert", () => {
    expect(
      leadIdFromChangePayload({ eventType: "INSERT", new: { id: "n1", lead_id: "L-1" } }),
    ).toBe("L-1");
  });

  it("reads lead_id from an update", () => {
    expect(
      leadIdFromChangePayload({
        eventType: "UPDATE",
        new: { id: "n1", lead_id: "L-1" },
        old: { lead_id: "L-1" },
      }),
    ).toBe("L-1");
  });

  it("reads lead_id from old on a delete, which needs replica identity full", () => {
    expect(
      leadIdFromChangePayload({ eventType: "DELETE", old: { id: "n1", lead_id: "L-1" } }),
    ).toBe("L-1");
  });

  it("returns null on a delete when only the primary key is sent", () => {
    // The real shape when replica identity is not FULL: no lead_id anywhere.
    expect(leadIdFromChangePayload({ eventType: "DELETE", old: { id: "n1" } })).toBeNull();
  });

  it("prefers new over old so an updated row is used", () => {
    expect(
      leadIdFromChangePayload({
        eventType: "UPDATE",
        new: { lead_id: "L-NEW" },
        old: { lead_id: "L-OLD" },
      }),
    ).toBe("L-NEW");
  });

  it("ignores a payload with no lead id rather than syncing a wrong lead", () => {
    expect(leadIdFromChangePayload({ eventType: "INSERT", new: { id: "n1" } })).toBeNull();
  });

  it("survives malformed input", () => {
    expect(leadIdFromChangePayload(null)).toBeNull();
    expect(leadIdFromChangePayload(undefined)).toBeNull();
    expect(leadIdFromChangePayload("nope")).toBeNull();
    expect(leadIdFromChangePayload({})).toBeNull();
    expect(leadIdFromChangePayload({ new: null, old: null })).toBeNull();
  });

  it("ignores a non-string lead id", () => {
    expect(leadIdFromChangePayload({ new: { lead_id: 12345 } })).toBeNull();
  });

  it("handles a photo payload, which carries lead_id too", () => {
    expect(
      leadIdFromChangePayload({ eventType: "INSERT", new: { id: "p1", lead_id: "L-2", photo_url: "x.jpg" } }),
    ).toBe("L-2");
  });
});

describe("leadIdFromLeadPayload", () => {
  it("reads id, not lead_id, from a leads event", () => {
    expect(leadIdFromLeadPayload({ eventType: "UPDATE", new: { id: "L-3", lead_id: "wrong" } })).toBe(
      "L-3",
    );
  });

  it("falls back to old", () => {
    expect(leadIdFromLeadPayload({ eventType: "DELETE", old: { id: "L-3" } })).toBe("L-3");
  });

  it("returns null when there is no id", () => {
    expect(leadIdFromLeadPayload({ eventType: "UPDATE", new: {} })).toBeNull();
    expect(leadIdFromLeadPayload(null)).toBeNull();
  });
});

describe("jobIdFromLeadPayload", () => {
  it("reads job_id from new", () => {
    expect(jobIdFromLeadPayload({ new: { id: "L-1", job_id: "J-1" } })).toBe("J-1");
  });

  it("falls back to old on a delete", () => {
    expect(jobIdFromLeadPayload({ old: { id: "L-1", job_id: "J-1" } })).toBe("J-1");
  });

  it("is undefined when absent", () => {
    expect(jobIdFromLeadPayload({ new: { id: "L-1" } })).toBeUndefined();
    expect(jobIdFromLeadPayload(null)).toBeUndefined();
  });
});

describe("isIgnorableEvent", () => {
  it("keeps the three real events", () => {
    expect(isIgnorableEvent("INSERT")).toBe(false);
    expect(isIgnorableEvent("UPDATE")).toBe(false);
    expect(isIgnorableEvent("DELETE")).toBe(false);
  });

  it("ignores anything else", () => {
    expect(isIgnorableEvent("TRUNCATE")).toBe(true);
    expect(isIgnorableEvent(undefined)).toBe(true);
    expect(isIgnorableEvent(null)).toBe(true);
  });
});