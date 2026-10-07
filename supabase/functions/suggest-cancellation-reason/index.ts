// =============================================================================
// suggest-cancellation-reason
//
// Reads the last 30 messages of a lead's conversation and asks an LLM to pick
// the most likely reason for cancellation from a strict list, plus a short
// explanation.
//
// Designed to be fast and non-blocking. A timeout or failure returns no
// suggestion, leaving the form fully usable for manual entry.
// =============================================================================

import { corsHeaders, jsonResponse, normalizePhone } from "../_shared/quo-ai.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_MESSAGES = 30;

const VALID_REASONS = [
  "Customer Declined Quote",
  "Customer Unreachable",
  "Found Another Provider",
  "Out of Service Area",
  "Duplicate Lead",
  "Job Not Needed",
  "Scheduling Conflict",
  "Other"
] as const;

const SYSTEM_PROMPT = `You suggest a cancellation reason based on the conversation between a customer and an agent.
Choose the single most accurate reason from the provided enum.
If none fit well, or if the conversation does not make it clear, choose "Other".
Also provide a very brief explanation (1-2 sentences max) based on the customer's own words where possible.

Do not invent a reason. Rely only on the transcript provided.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason_code", "explanation"],
  properties: {
    reason_code: {
      type: "string",
      enum: VALID_REASONS,
    },
    explanation: {
      type: "string",
      description: "A very brief explanation (1-2 sentences) of why this reason was chosen, quoting the customer if possible.",
    },
  },
} as const;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function findConversationId(
  supabase: ReturnType<typeof createClient>,
  leadId: string,
  customerPhone: string | null,
): Promise<{ conversationId: string | null }> {
  const { data: linked } = await supabase
    .from("quo_conversations")
    .select("id")
    .eq("linked_lead_id", leadId)
    .order("last_message_time", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (linked?.id) return { conversationId: linked.id };

  const e164 = normalizePhone(customerPhone);
  if (!e164) return { conversationId: null };

  const { data: matches } = await supabase
    .from("quo_conversations")
    .select("id")
    .eq("customer_number", e164)
    .order("last_message_time", { ascending: false })
    .limit(5);

  return matches?.length
    ? { conversationId: matches[0].id as string }
    : { conversationId: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ suggestion: null, notice: "AI is not configured." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return jsonResponse({ error: "Not signed in." }, 401);

  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: "Not signed in." }, 401);

  let body: { leadId?: unknown };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  const leadId = text(body.leadId);
  if (!leadId) return jsonResponse({ error: "leadId is required." }, 400);

  const startedAt = Date.now();

  const { data: lead, error: leadError } = await supabaseUser
    .from("leads")
    .select("id, customer_phone")
    .eq("id", leadId)
    .maybeSingle();

  if (leadError || !lead) return jsonResponse({ suggestion: null, notice: "Lead not found." });

  const { conversationId } = await findConversationId(
    supabaseUser,
    leadId,
    text(lead.customer_phone) || null,
  );

  if (!conversationId) {
    return jsonResponse({
      suggestion: null,
      notice: "No conversation found.",
      elapsed_ms: Date.now() - startedAt,
    });
  }

  // Fetch only the last ~30 messages to keep it fast
  const { data: messages, error: messageError } = await supabaseUser
    .from("quo_messages")
    .select("sender, text, message_time")
    .eq("conversation_id", conversationId)
    .order("message_time", { ascending: false }) // desc to get newest
    .limit(MAX_MESSAGES);

  if (messageError) return jsonResponse({ suggestion: null, notice: messageError.message });

  if (!messages || messages.length === 0) {
    return jsonResponse({
      suggestion: null,
      notice: "No messages in conversation.",
      elapsed_ms: Date.now() - startedAt,
    });
  }

  // Re-order ascending for the transcript
  const lines = messages
    .reverse()
    .filter((message) => text(message.text).trim().length > 0)
    .map((message) => {
      const who = text(message.sender).toLowerCase() === "customer" ? "CUSTOMER" : "AGENT";
      return `${who}: ${text(message.text).trim()}`;
    });

  if (!lines.length) {
    return jsonResponse({
      suggestion: null,
      notice: "No message text available.",
      elapsed_ms: Date.now() - startedAt,
    });
  }

  const transcript = lines.join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const openaiResponse = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 80,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "cancellation_suggestion",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `--- BEGIN TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---\n\nWhat is the cancellation reason?`,
          },
        ],
      }),
    });

    if (!openaiResponse.ok) {
      console.error("openai_error", openaiResponse.status);
      return jsonResponse({ suggestion: null, notice: "AI unavailable." }, 200);
    }

    const payload = await openaiResponse.json();
    const raw = payload?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(raw ?? "{}");

    if (!parsed.reason_code || !VALID_REASONS.includes(parsed.reason_code)) {
       return jsonResponse({ suggestion: null, notice: "AI returned invalid response." }, 200);
    }

    return jsonResponse({
      suggestion: {
        reason_code: parsed.reason_code,
        explanation: parsed.explanation || "",
      },
      notice: null,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    console.error("check_failed", aborted ? "timeout" : "exception");
    return jsonResponse(
      {
        suggestion: null,
        notice: aborted ? "Timeout" : "Error",
        elapsed_ms: Date.now() - startedAt,
      },
      200,
    );
  } finally {
    clearTimeout(timer);
  }
});
