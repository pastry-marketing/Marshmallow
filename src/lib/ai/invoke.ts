import { supabase } from "@/integrations/supabase/client";

// =============================================================================
// Client side of the advisory AI features.
//
// supabase.functions.invoke has two traps this wraps once for every feature:
//
//   1. No timeout of its own. The edge function aborts its own OpenAI call, but
//      DNS, TLS and the hop to Supabase can each stall past that, and nobody
//      should be left watching a spinner with no way out.
//
//   2. The function's JSON body is NOT in error.message. supabase-js puts the
//      Response in error.context and sets error.message to a generic "non-2xx
//      status code", so reading only the message turns a quota failure and a
//      misconfigured key into the same unhelpful string. We read the body.
//
// Every AI feature result is advisory: this returns a discriminated union so a
// caller must handle the failure path, never silently treat an outage as a pass.
// =============================================================================

// A flat result rather than a discriminated union on purpose: this project
// builds with strictNullChecks off (tsconfig strict: false), where TypeScript
// does not reliably narrow a union by a boolean discriminant — the same reason
// the rest of the codebase works with { data, error } shapes. `ok` says which
// half is meaningful: on success `data` is set; on failure `reason`/`message`.
export type AiInvokeResult<T> = {
  ok: boolean;
  data: T | null;
  reason: string;
  message: string;
};

export async function invokeAi<T>(
  fn: string,
  body: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<AiInvokeResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { data, error } = await supabase.functions.invoke(fn, {
      body,
      signal: controller.signal,
    } as never);

    if (error) {
      let message = "";
      let reason = "unknown";
      const context = (error as { context?: unknown }).context;

      if (context && typeof Response !== "undefined" && context instanceof Response) {
        try {
          const parsed = (await context.clone().json()) as Record<string, unknown>;
          if (typeof parsed?.error === "string") message = parsed.error;
          if (typeof parsed?.reason === "string") reason = parsed.reason;
        } catch {
          // A non-JSON body. Nothing to add beyond the generic message below.
        }
      }

      return {
        ok: false,
        data: null,
        reason,
        message:
          message ||
          (error.name === "AbortError"
            ? "The AI request timed out. Please try again."
            : error.message || "The AI service could not be reached. Check your connection."),
      };
    }

    return { ok: true, data: (data ?? {}) as T, reason: "", message: "" };
  } finally {
    clearTimeout(timer);
  }
}
