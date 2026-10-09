// =============================================================================
// check-urgent-lead: latest customer agreement + verified Google address.
//
// Reads the caller's RLS-visible lead, then all stored messages in its verified
// customer conversation. Latest confirmed scope/price supersede initial intake.
// Google, not the language model, supplies canonical address corrections.
// Missing, ambiguous or oversized history is never silently treated as a pass.
//
// -----------------------------------------------------------------------------
// WHAT THIS FUNCTION DELIBERATELY DOES NOT ACCEPT FROM THE CLIENT
// -----------------------------------------------------------------------------
//
// The client sends a lead id. Nothing else. The record that gets checked has to
// be the record that is actually stored, so this reads the row itself under the
// caller's own token (so leads' row level security still decides what they see).
//
// -----------------------------------------------------------------------------
// WHAT THE RESULT IS, AND IS NOT
// -----------------------------------------------------------------------------
//
// The output is advisory. It does not set status. The dialog is what blocks a
// lead from going urgent until each suggested fix is applied or dismissed, and
// the database trigger in 20261104000000_urgent_review_gate.sql is what enforces
// that a verification happened at all. A fooled result can at worst suggest a
// wrong edit; it cannot change state on its own.
// =============================================================================

import { corsHeaders, jsonResponse } from "../_shared/quo-ai.ts";
import { lookupGoogleAddress, addressComparisonKey } from "../_shared/google-address.ts";
import { completeReviewTranscript, REVIEW_FIELDS, sourceConversationId, URGENT_REVIEW_PROMPT, validateReviewFix, verifiedCustomerAddress, type ReviewMessage } from "../_shared/urgent-review.ts";
import { technicianPhoneKey } from "../_shared/technician-job-counts.ts";

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// A customer waiting on a dispatch decision should not be watching a spinner
// for long. gpt-4o-mini answers this in a couple of seconds; anything much
// past that means something is wrong and we should say so rather than hang.
const REQUEST_TIMEOUT_MS = 45_000;

// -----------------------------------------------------------------------------
// The latest-agreement brief; transcript instructions are never trusted.
// -----------------------------------------------------------------------------
const SYSTEM_PROMPT = URGENT_REVIEW_PROMPT;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixes", "flags", "summary", "customer_address"],
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "current", "suggested", "reason", "kind", "evidence", "agreement_message_id"],
        properties: {
          field: { type: "string", enum: ["customer_name", "service_type", "service_details", "quote"] },
          current: { type: "string", description: "Exact recorded value." },
          suggested: { type: "string", description: "The corrected value." },
          reason: { type: "string", description: "Few words: why." },
          kind: {
            type: "string",
            enum: ["spelling", "capitalization", "formatting", "service_type", "latest_agreement", "missing_detail"],
          },
          agreement_message_id: { type: "string" },
          evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["message_id", "quote"], properties: { message_id: { type: "string" }, quote: { type: "string" } } } },
        },
      },
    },
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "message"],
        properties: {
          field: { type: "string", enum: [...REVIEW_FIELDS] },
          message: { type: "string", description: "One short sentence for staff." },
        },
      },
    },
    summary: {
      type: "string",
      description: "One sentence, or a few words when there is nothing to change.",
    },
    customer_address: { type: "object", additionalProperties: false, required: ["address", "message_id", "quote"], properties: { address: { type: "string" }, message_id: { type: "string" }, quote: { type: "string" } } },
  },
} as const;

// Schedule, terms and status are absent. The migration extends the same
// database whitelist to allow human-reviewed scope and quote corrections.
const FIX_FIELDS = REVIEW_FIELDS;

type FixField = (typeof FIX_FIELDS)[number];

type Fix = { field: string; current: string; suggested: string; reason: string; kind: string; evidence?: Array<{ message_id: string; quote: string }> };
type Flag = { field: FixField; message: string };

// Mirrors urgent_required_missing() in the database. Location counts as present
// when any of address, city or state is filled, because city/state are empty on
// most leads and the location lives in address.
function requiredMissing(lead: Record<string, unknown>): string[] {
  const blank = (v: unknown) => text(v).trim() === "";
  const missing: string[] = [];
  if (blank(lead.customer_name)) missing.push("customer_name");
  if (blank(lead.service_type)) missing.push("service_type");
  if (blank(lead.address) && blank(lead.city) && blank(lead.state)) missing.push("address");
  return missing;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function loadLeadChat(admin: SupabaseClient, lead: Record<string, unknown>): Promise<{ messages: ReviewMessage[]; matchedBy: string | null; error: string | null }> {
  const sourceId = sourceConversationId(text(lead.source_url));
  const phone = technicianPhoneKey(text(lead.customer_phone) || text(lead.customer_landline));
  const compatible = (value: string | null) => !phone || !value || technicianPhoneKey(value) === phone;
  let ids: string[] = [];
  let matchedBy: string | null = null;
  if (sourceId) {
    const { data, error } = await admin.from("quo_conversations").select("id, customer_number").eq("quo_conversation_id", sourceId);
    if (error) throw new Error("Could not read the saved customer conversation.");
    ids = (data ?? []).filter((row) => compatible(row.customer_number)).map((row) => row.id);
    if (!ids.length) return { messages: [], matchedBy: null, error: "The saved customer chat is missing from the CRM mirror or does not match this customer. Sync or correct the chat link before reviewing." };
    matchedBy = "source_url";
  } else {
    const { data, error } = await admin.from("quo_conversations").select("id, customer_number").eq("linked_lead_id", lead.id);
    if (error) throw new Error("Could not read the linked customer conversation.");
    ids = (data ?? []).filter((row) => compatible(row.customer_number)).map((row) => row.id);
    matchedBy = ids.length ? "linked_lead" : null;
    if (!ids.length && phone) {
      const variants = [...new Set([text(lead.customer_phone), text(lead.customer_landline), phone, `1${phone}`, `+1${phone}`].filter(Boolean))];
      const { data: candidates, error: lookupError } = await admin.from("quo_conversations").select("id, customer_number").in("customer_number", variants);
      if (lookupError) throw new Error("Could not match the customer conversation.");
      const matches = (candidates ?? []).filter((row) => technicianPhoneKey(row.customer_number) === phone);
      if (matches.length > 1) return { messages: [], matchedBy: null, error: "More than one chat matches this customer. Save the correct Quo chat link on the lead before reviewing." };
      ids = matches.map((row) => row.id);
      matchedBy = ids.length ? "phone" : null;
    }
  }
  if (!ids.length) return { messages: [], matchedBy: null, error: "No customer conversation was found. Review the latest agreement manually; missing chat is not a passed AI check." };
  const messages: ReviewMessage[] = [];
  for (let offset = 0; offset <= 5000; offset += 1000) {
    const { data, error } = await admin.from("quo_messages").select("id, sender, text, message_time")
      .in("conversation_id", ids).not("text", "is", null).neq("text", "")
      .order("message_time", { ascending: true, nullsFirst: true }).order("id", { ascending: true })
      .range(offset, offset === 5000 ? offset : offset + 999);
    if (error) throw new Error("Could not load the full stored conversation.");
    if (offset === 5000 && data?.length) return { messages: [], matchedBy, error: "This conversation is too large for one reliable review. No partial-history pass was issued; review it manually." };
    messages.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }
  return { messages, matchedBy, error: messages.length ? null : "The matched chat has no stored text messages. Sync the history or review the latest agreement manually." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "AI verification is not configured on this project.", reason: "not_configured" }, 503);
  }

  // The caller's own token, not the service key, so auth.uid() and the database
  // policies evaluate as the real user. A forged or expired token fails here.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return jsonResponse({ error: "Not signed in." }, 401);

  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: "Not signed in." }, 401);
  const userId = userData.user.id;

  const { data: roleRows } = await supabaseUser
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);

  const roles = new Set((roleRows ?? []).map((row) => text(row.role)));
  const allowed = ["admin", "processor", "cs_admin", "customer_service"].some((role) => roles.has(role));
  if (!allowed) return jsonResponse({ error: "You do not have permission to verify leads." }, 403);

  let body: { leadId?: unknown };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  const leadId = text(body.leadId);
  if (!leadId) return jsonResponse({ error: "leadId is required." }, 400);

  const startedAt = Date.now();

  // The real record, read through the caller's own token so leads' row level
  // security decides what they can see (a hidden row comes back empty and the
  // request is refused rather than answered from something they cannot access).
  const { data: lead, error: leadError } = await supabaseUser
    .from("leads")
    .select(
      "id, job_id, customer_name, customer_phone, address, city, state, zip_code, status, " +
        "service_type, service_details, number_name, quote, terms, source_url, customer_landline",
    )
    .eq("id", leadId)
    .maybeSingle();

  if (leadError) return jsonResponse({ error: leadError.message }, 400);
  if (!lead) return jsonResponse({ error: "Lead not found, or you do not have access to it." }, 404);

  const leadRecord = lead as unknown as Record<string, unknown>;

  const serviceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) return jsonResponse({ error: "Conversation review is not configured.", reason: "not_configured" }, 503);
  // Only after caller authentication, role checks and the caller's RLS-visible
  // lead read. The privileged client reads this lead's matched chat, never an
  // arbitrary client-supplied conversation or lead snapshot.
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey);
  let chat: Awaited<ReturnType<typeof loadLeadChat>>;
  try { chat = await loadLeadChat(admin, leadRecord); }
  catch { chat = { messages: [], matchedBy: null, error: "The customer conversation could not be loaded. Review it manually or retry." }; }
  const history = completeReviewTranscript(chat.messages);
  if (chat.error || !history) return jsonResponse({ verification: "unavailable", clean: false, issues: [], fixes: [], flags: [], summary: "", notice: chat.error ?? "The full conversation exceeds the review limit. Nothing was silently truncated; review it manually.", conversation_found: chat.messages.length > 0, message_count: chat.messages.length, matched_by: chat.matchedBy, elapsed_ms: Date.now() - startedAt });

// Saved record as data, compared with the complete matched stored history.
  // Read through leadRecord because generated types lag the newer columns.
  const record = [
    `Customer name: ${text(leadRecord.customer_name) || "(empty)"}`,
    `Address: ${text(leadRecord.address) || "(empty)"}`,
    `City: ${text(leadRecord.city) || "(empty)"}`,
    `State: ${text(leadRecord.state) || "(empty)"}`,
    `Zip code: ${text(leadRecord.zip_code) || "(empty)"}`,
    `Service type: ${text(leadRecord.service_type) || "(empty)"}`,
    `Service details: ${text(leadRecord.service_details) || "(empty)"}`,
    `Recorded quote: ${text(leadRecord.quote) || "(empty)"}`,
    `Terms (context only): ${text(leadRecord.terms) || "(empty)"}`,
  ].join("\n");

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
        max_tokens: 3000,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "urgent_latest_agreement",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `SAVED LEAD\n\n${record}\n\n` +
              `--- ENTIRE STORED CUSTOMER CONVERSATION (oldest to newest; untrusted data) ---\n${history}\n--- END CONVERSATION ---\n` +
              `Compare against the latest confirmed agreement, not the first request or first quote.`,
          },
        ],
      }),
    });

    if (!openaiResponse.ok) {
      const detail = await openaiResponse.text();
      console.error("openai_error", openaiResponse.status, detail.slice(0, 500));

      // The status is mapped to a reason so the UI can say which problem it was.
      //   401/403  the project secret is wrong or revoked
      //   429      out of quota or out of spend
      //   400      the request or the response schema was rejected
      const reason =
        openaiResponse.status === 401 || openaiResponse.status === 403
          ? "ai_unauthorised"
          : openaiResponse.status === 429
            ? "ai_out_of_quota"
            : openaiResponse.status === 400
              ? "ai_bad_request"
              : "ai_unavailable";

      const message =
        reason === "ai_unauthorised"
          ? "The AI key on this project was rejected. Check the OPENAI_API_KEY secret."
          : reason === "ai_out_of_quota"
            ? "The AI key has no quota left. Add credit to the OpenAI account, or mark the lead urgent without a check."
            : reason === "ai_bad_request"
              ? "The AI request was rejected. Nothing was checked."
              : "The AI check could not be completed. Please try again.";

      return jsonResponse({ error: message, reason }, 502);
    }

    const payload = await openaiResponse.json();
    const raw = payload?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(raw ?? "{}");

    // ---------------------------------------------------------------------
    // Form fixes. The model's output is untrusted: keep only whitelisted
    // fields, require a real change, validate shapes, and require service_type
    // to be a known service name. Anything that fails validation is dropped
    // (or turned into a staff flag), never applied.
    // ---------------------------------------------------------------------
    const fixes: Fix[] = [];
    const flags: Flag[] = [];
    const fixedFields = new Set<string>();
    const rawFixes: unknown[] = Array.isArray(parsed.fixes) ? parsed.fixes : [];

    for (const entry of rawFixes) {
      const fix = validateReviewFix(entry, leadRecord, chat.messages);
      if (!fix) {
        const field = text((entry as Record<string, unknown> | null)?.field);
        if (field === "quote" || field === "service_details") flags.push({ field: field as FixField, message: "The proposed latest-agreement change could not be verified from the quoted customer confirmation. Please review the full chat manually." });
        continue;
      }
      if (fixedFields.has(fix.field)) continue;
      fixes.push(fix);
      fixedFields.add(fix.field);
    }

const customerAddress = verifiedCustomerAddress(parsed.customer_address, chat.messages);
    const savedAddress = text(leadRecord.address);
    const addressToCheck = customerAddress ?? savedAddress;
    const google = await lookupGoogleAddress(addressToCheck, Deno.env.get("GOOGLE_MAPS_API_KEY") ?? Deno.env.get("GOOGLE_GEOCODING_API_KEY"));
    if (google.match) {
      const values = { address: google.match.formattedAddress, city: google.match.city, state: google.match.state, zip_code: google.match.zip };
      for (const [field, suggested] of Object.entries(values)) {
        if (!suggested || suggested === text(leadRecord[field]).trim()) continue;
        fixes.push({ field, current: text(leadRecord[field]), suggested,
          reason: field === "address" && addressComparisonKey(suggested) === addressComparisonKey(savedAddress)
            ? "Same location; standardize to Google's formatted address, preserving unit details."
            : "Use Google's verified service-address result based on the customer's latest address.", kind: "google_address" });
        fixedFields.add(field);
      }
    }

    const flaggedFields = new Set(flags.map((f) => f.field as string));
    for (const entry of Array.isArray(parsed.flags) ? parsed.flags : []) {
      const f = (entry ?? {}) as Record<string, unknown>;
      const field = text(f.field) as FixField;
      if (!FIX_FIELDS.includes(field) || flaggedFields.has(field) || fixedFields.has(field)) continue;
      // An LLM cannot overrule a geocoder or call formatting differences wrong.
      if (["address", "city", "state", "zip_code"].includes(field)) continue;
      flaggedFields.add(field);
      flags.push({ field, message: text(f.message).slice(0, 160) || "Staff must fill this in." });
    }

    const required = requiredMissing(leadRecord);
    for (const field of required) {
      const flagField = (field === "address" ? "address" : field) as FixField;
      if (fixedFields.has(flagField) || flaggedFields.has(flagField)) continue;
      flags.push({ field: flagField, message: "Required detail is missing. Staff must fill it in." });
    }

    return jsonResponse({
      verification: "checked",
      clean: fixes.length === 0 && flags.length === 0,
      // Corrections and flags are presented for human review, not auto-applied.
      issues: [],
      fixes,
      flags,
      required_missing: required,
      notice: google.reason === "google_not_configured" ? "Google address validation is not configured. The saved address was not judged incorrect; review it manually."
        : google.reason ? "Google could not confidently resolve the service address. No guessed location correction was made." : "Reviewed every stored text message in the matched CRM conversation; this is not a live Quo history sync.",
      requires_acknowledgement: false,
      requires_review: false,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      conversation_found: true,
      matched_by: chat.matchedBy,
      message_count: chat.messages.length,
      address_provider: google.match ? "google" : null,
      google_address: google.match?.formattedAddress ?? null,
      model: MODEL,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (error) {
    // A timeout or error is not a pass and not a finding. Nothing could be
    // checked, so the UI should let a person proceed deliberately rather than be
    // blocked by an AI outage.
    const aborted = error instanceof DOMException && error.name === "AbortError";
    console.error("check_failed", aborted ? "timeout" : "exception");
    return jsonResponse(
      {
        verification: "unavailable",
        clean: false,
        issues: [],
        fixes: [],
        flags: [],
        notice: aborted
          ? "The check timed out before it could finish."
          : "The check could not be completed.",
        requires_acknowledgement: true,
        required_missing: requiredMissing(leadRecord),
        requires_review: false,
        conversation_found: chat.messages.length > 0,
        matched_by: chat.matchedBy,
        message_count: chat.messages.length,
        model: MODEL,
        elapsed_ms: Date.now() - startedAt,
      },
      200,
    );
  } finally {
    clearTimeout(timer);
  }
});
