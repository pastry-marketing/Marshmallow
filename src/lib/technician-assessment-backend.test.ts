// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { technicianJobCounts, technicianPhoneKey } from "../../supabase/functions/_shared/technician-job-counts";
import { parseTechnicianQuoLink } from "../../supabase/functions/_shared/technician-quo-link";
import { supportsTechnicianLabel } from "../../supabase/functions/_shared/technician-label-evidence";
import { historyTranscript, verifyHistoryEvidence, readLinkedTechnicianHistory } from "../../supabase/functions/_shared/technician-history";

const source = readFileSync("supabase/functions/technician-chat-assessment/index.ts", "utf8").replace(/^import .*;\r?$/gm, "");
afterEach(() => vi.unstubAllGlobals());

function setup(role: string) {
  const tables: Record<string, unknown[]> = {
    user_roles: [{ role }], leads: [],
    technicians: [{ id: "fixture-tech", name: "Fixture Tech", phone_number: "4155550123", chat_link: "https://my.quo.com/inbox/PN12345678/c/CN12345678", is_active: true }],
    quo_conversations: [{ id: "mirror-chat", quo_conversation_id: "CN12345678", customer_number: "+14155550123" }],
    quo_messages: [{ id: "old", conversation_id: "mirror-chat", sender: "customer", text: "Old mirrored message", message_time: "2026-09-01T00:00:00Z" }],
    technician_workflow_assessments: [],
  };
  const from = (table: string) => {
    const builder = {
      select: () => builder, eq: () => builder, in: () => builder, ilike: () => builder,
      order: () => builder, limit: () => builder, range: () => builder, not: () => builder, neq: () => builder,
      upsert: vi.fn(() => builder),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: tables[table] || [], error: null }).then(resolve),
    };
    return builder;
  };
  const fetcher = vi.fn(async (url: string) => url.includes("/messages?")
    ? { ok: true, json: async () => ({ data: [{ id: "fresh", conversationId: "CN12345678", phoneNumberId: "PN12345678", direction: "incoming", text: "Fresh technician message from Quo", createdAt: "2026-10-10T00:00:00Z" }], nextPageToken: null }) }
    : { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ labels: [], recommendations: [], summary: "Fresh review complete", evidence: [] }) } }] }) });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("AbortSignal", { timeout: () => new AbortController().signal });
  class FakeResponse {
    constructor(private body: string, public options: { status: number }) {}
    get status() { return this.options.status; }
    async json() { return JSON.parse(this.body); }
  }
  let handler!: (request: unknown) => Promise<FakeResponse>;
  runInNewContext(transformSync(source, { loader: "ts", format: "esm" }).code, {
    createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "fixture-user" } }, error: null }) }, from }),
    technicianJobCounts, technicianPhoneKey, parseTechnicianQuoLink, supportsTechnicianLabel,
    historyTranscript, verifyHistoryEvidence, readLinkedTechnicianHistory,
    Response: FakeResponse, AbortSignal: { timeout: () => new AbortController().signal }, fetch: fetcher,
    Deno: { env: { get: (name: string) => ["OPENAI_API_KEY", "QUO_API_KEY", "SB_SERVICE_ROLE_KEY"].includes(name) ? "fixture-key" : undefined }, serve: (callback: typeof handler) => { handler = callback; } },
  });
  const request = (body: unknown) => handler({ method: "POST", headers: { get: () => "Bearer fixture-session" }, json: async () => body });
  return { request, fetcher };
}

describe("technician assessment backend contract", () => {
  it("reads fresh Quo history rather than treating a nonempty stale mirror as current", async () => {
    const { request, fetcher } = setup("admin");
    const response = await request({ action: "assess", technicianIds: ["fixture-tech"] });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.results[0]).toMatchObject({ chatSource: "Quo direct", messagesReviewed: 1, conversationsReviewed: 1, error: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects customer-service access before reading chats or calling AI", async () => {
    const { request, fetcher } = setup("customer_service");
    expect((await request({ action: "assess", technicianIds: ["fixture-tech"] })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsupported labels instead of silently saving an empty label set", async () => {
    const { request } = setup("processor");
    expect((await request({ action: "save_labels", technicianId: "fixture-tech", labels: ["untrusted-label"] })).status).toBe(400);
  });
});
