import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

import { supabase } from "@/integrations/supabase/client";
import { invokeAi } from "./invoke";

const invoke = () => vi.mocked(supabase.functions.invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invokeAi", () => {
  it("returns the data on success", async () => {
    invoke().mockResolvedValue({ data: { hello: "world" }, error: null } as never);
    const res = await invokeAi<{ hello: string }>("ai-thing", { x: 1 });
    expect(res).toEqual({ ok: true, data: { hello: "world" }, reason: "", message: "" });
  });

  it("reads error and reason out of the Response body", async () => {
    const body = { error: "The AI key has no quota left.", reason: "ai_out_of_quota" };
    const response = new Response(JSON.stringify(body), { status: 502 });
    invoke().mockResolvedValue({
      data: null,
      error: Object.assign(new Error("non-2xx"), { context: response }),
    } as never);

    const res = await invokeAi("ai-thing", {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("ai_out_of_quota");
    expect(res.message).toBe("The AI key has no quota left.");
  });

  it("falls back to a generic message when there is no JSON body", async () => {
    invoke().mockResolvedValue({
      data: null,
      error: Object.assign(new Error("boom"), { context: null }),
    } as never);

    const res = await invokeAi("ai-thing", {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unknown");
    expect(res.message).toBe("boom");
  });

  it("explains a timeout/abort distinctly", async () => {
    invoke().mockResolvedValue({
      data: null,
      error: Object.assign(new Error(""), { name: "AbortError", context: null }),
    } as never);

    const res = await invokeAi("ai-thing", {});
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/timed out/i);
  });

  it("defaults missing data to an empty object", async () => {
    invoke().mockResolvedValue({ data: null, error: null } as never);
    const res = await invokeAi("ai-thing", {});
    expect(res).toEqual({ ok: true, data: {}, reason: "", message: "" });
  });
});
