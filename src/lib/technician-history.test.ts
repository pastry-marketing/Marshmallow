import { afterEach, describe, expect, it, vi } from "vitest";
import { historyTranscript, readLinkedTechnicianHistory, verifyHistoryEvidence } from "../../supabase/functions/_shared/technician-history";

afterEach(() => vi.unstubAllGlobals());
const options = { chatLink: "https://my.quo.com/inbox/PN12345678/c/CN12345678", phone: "4155550123", apiKey: "test-key" };

describe("technician history evidence", () => {
  it("does not let an AI quote change the speaker or alter the source text", () => {
    const messages = [
      { id: "team", conversation_id: "chat", sender: "agent", text: "I owe you the overdue payment.", message_time: "2026-10-10T04:00:00Z" },
      { id: "tech", conversation_id: "chat", sender: "customer", text: "I already sent the full payment.", message_time: "2026-10-10T05:00:00Z" },
    ];
    expect(verifyHistoryEvidence([{ label: "late_payment", quote: messages[0].text, message_id: "team", source: "Technician / contact" }], messages, ["late_payment"]))
      .toMatchObject([{ source: "Our team", message_id: "team", message_time: "2026-10-10T04:00:00Z" }]);
    expect(verifyHistoryEvidence([{ label: "late_payment", quote: "I sent the full payment.", message_id: "tech" }], messages, ["late_payment"])).toEqual([]);
    expect(() => historyTranscript([{ ...messages[0], message_time: "invalid" }])).not.toThrow();
  });

  it("reports the exact missing secret without calling Quo", async () => {
    const fetcher = vi.fn();
    expect((await readLinkedTechnicianHistory({ ...options, apiKey: undefined, fetcher })).error).toContain("QUO_API_KEY");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses pagination, deduplicates messages and excludes wrong conversation/line messages", async () => {
    vi.stubGlobal("AbortSignal", { timeout: () => new AbortController().signal });
    const item = { id: "AC1", conversationId: "CN12345678", phoneNumberId: "PN12345678", direction: "incoming", text: "Available for the job tomorrow", createdAt: "2026-10-10T04:00:00Z" };
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [item, { ...item, id: "wrong", conversationId: "CNsomeoneelse" }], nextPageToken: "page2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [item, { ...item, id: "wrong-line", phoneNumberId: "PNelse" }], nextPageToken: null }) });
    const result = await readLinkedTechnicianHistory({ ...options, fetcher });
    expect(result.messages).toHaveLength(1);
    expect(result.error).toBeNull();
    expect(fetcher.mock.calls[1][0]).toContain("pageToken=page2");
    expect(fetcher.mock.calls[0][0]).toContain("participants=%2B14155550123");
  });
});
