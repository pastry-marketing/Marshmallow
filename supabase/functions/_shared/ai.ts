// =============================================================================
// _shared/ai.ts — common plumbing for the advisory AI features
//
// Every feature on the AI roadmap (reply suggestions, conversation triage,
// shift briefing, lead auto-fill, quote assistant, schedule assistant, lead
// scoring, spam/scam detection, call action items, quality checking, copilot)
// follows the same shape:
//
//   1. authenticate the caller by THEIR OWN token and check their role,
//   2. read context (lead / conversation / messages) through that same token so
//      row level security decides what they can see,
//   3. ask gpt-4o-mini for a STRICT JSON-schema answer, with a timeout,
//   4. return an advisory result — nothing in here changes state on its own.
//
// The two older functions (check-urgent-lead, refresh-urgent-statuses) predate
// this module and keep their own inline copies on purpose: they work, they are
// covered by the urgent gate, and rewriting them to share code would be risk
// with no feature behind it. This module is for the new features so they stay
// consistent without that refactor.
// =============================================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, normalizePhone } from "./quo-ai.ts";

export const AI_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function getOpenAiKey(): string | null {
  return Deno.env.get("OPENAI_API_KEY") ?? null;
}

// ---------------------------------------------------------------------------
// Auth. The caller's token, never the service key, so auth.uid() and the leads
// / quo_* policies evaluate as the real user. A forged or expired token fails
// here, and a user can never pull context they could not see in the app.
// ---------------------------------------------------------------------------
export type Caller = {
  userId: string;
  roles: Set<string>;
  client: SupabaseClient;
};

export async function authenticateCaller(
  req: Request,
  allowedRoles: readonly string[],
): Promise<Caller | Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return jsonResponse({ error: "Not signed in." }, 401);

  const client = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: "Not signed in." }, 401);

  const { data: roleRows } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id);
  const roles = new Set((roleRows ?? []).map((row) => asText(row.role)));

  if (allowedRoles.length > 0 && !allowedRoles.some((role) => roles.has(role))) {
    return jsonResponse({ error: "You do not have permission to use this AI feature." }, 403);
  }

  return { userId: userData.user.id, roles, client };
}

// ---------------------------------------------------------------------------
// The model call. One place that maps OpenAI's failures to a reason the UI can
// explain, so a quota failure and a bad key never look the same to the user.
// ---------------------------------------------------------------------------
export type OpenAiOk<T> = { ok: true; data: T; elapsedMs: number };
export type OpenAiErr = {
  ok: false;
  status: number;
  reason: string;
  message: string;
  elapsedMs: number;
};

export async function openAiJson<T>(options: {
  apiKey: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<OpenAiOk<T> | OpenAiErr> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 700,
        response_format: {
          type: "json_schema",
          json_schema: { name: options.schemaName, strict: true, schema: options.schema },
        },
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("openai_error", res.status, detail.slice(0, 300));
      const reason =
        res.status === 401 || res.status === 403
          ? "ai_unauthorised"
          : res.status === 429
            ? "ai_out_of_quota"
            : res.status === 400
              ? "ai_bad_request"
              : "ai_unavailable";
      const message =
        reason === "ai_unauthorised"
          ? "The AI key on this project was rejected. Check the OPENAI_API_KEY secret."
          : reason === "ai_out_of_quota"
            ? "The AI key has no quota left. Add credit to the OpenAI account."
            : reason === "ai_bad_request"
              ? "The AI request was rejected. Nothing was produced."
              : "The AI service could not be reached. Please try again.";
      return { ok: false, status: 502, reason, message, elapsedMs: Date.now() - startedAt };
    }

    const payload = await res.json();
    const raw = payload?.choices?.[0]?.message?.content;
    const data = JSON.parse(raw ?? "{}") as T;
    return { ok: true, data, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    console.error("openai_failed", aborted ? "timeout" : "exception");
    return {
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? "ai_timeout" : "ai_unavailable",
      message: aborted
        ? "The AI request timed out before it could finish."
        : "The AI service could not be reached. Please try again.",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Conversation context. The customer half of a transcript is untrusted text;
// callers that prompt with it fence it and say so in the system prompt.
// ---------------------------------------------------------------------------
export type TranscriptLine = { sender: "CUSTOMER" | "AGENT"; text: string; at: string | null };

export async function loadConversationTranscript(
  client: SupabaseClient,
  conversationId: string,
  maxMessages = 40,
): Promise<{ lines: TranscriptLine[]; lastMessageAt: string | null; customerCount: number }> {
  const { data, error } = await client
    .from("quo_messages")
    .select("sender, text, message_time")
    .eq("conversation_id", conversationId)
    .order("message_time", { ascending: false })
    .limit(maxMessages);
  if (error) throw new Error(error.message);

  const rows = (data ?? []).slice().reverse();
  const lines: TranscriptLine[] = [];
  let lastMessageAt: string | null = null;
  let customerCount = 0;

  for (const row of rows) {
    const t = asText(row.text).trim();
    const at = asText(row.message_time) || null;
    if (at && (!lastMessageAt || at > lastMessageAt)) lastMessageAt = at;
    if (!t) continue;
    const sender = asText(row.sender).toLowerCase() === "customer" ? "CUSTOMER" : "AGENT";
    if (sender === "CUSTOMER") customerCount += 1;
    lines.push({ sender, text: t.slice(0, 600), at });
  }

  return { lines, lastMessageAt, customerCount };
}

export function renderTranscript(lines: TranscriptLine[]): string {
  return lines.map((line) => `${line.sender}: ${line.text}`).join("\n");
}

// ---------------------------------------------------------------------------
// Resolve the customer conversation behind a lead: an explicit link first, then
// the customer's phone number. Returns the most recently active match.
// ---------------------------------------------------------------------------
export async function resolveLeadConversation(
  client: SupabaseClient,
  lead: { id: string; customer_phone?: string | null },
): Promise<{ id: string } | null> {
  const { data: linked } = await client
    .from("quo_conversations")
    .select("id, last_message_at")
    .eq("linked_lead_id", lead.id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (linked && linked.length > 0) return { id: asText(linked[0].id) };

  const phone = normalizePhone(lead.customer_phone);
  if (!phone) return null;

  const { data: byPhone } = await client
    .from("quo_conversations")
    .select("id, last_message_at")
    .eq("customer_number", phone)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (byPhone && byPhone.length > 0) return { id: asText(byPhone[0].id) };

  return null;
}
