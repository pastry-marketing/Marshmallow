// =============================================================================
// check-urgent-lead  (form-only phase)
//
// Checks a lead's FORM FIELDS for formatting problems before the lead is allowed
// to become urgent, and returns one-click corrections plus flags for missing
// required details.
//
// -----------------------------------------------------------------------------
// THIS PHASE DOES NOT READ THE QUO CUSTOMER CHAT
// -----------------------------------------------------------------------------
//
// An earlier version compared the record against the customer's conversation.
// For this phase the correction is deliberately form-only: it looks at the saved
// lead fields alone (spelling, grammar, capitalization, formatting, city/state,
// and whether the service type matches the recorded work) so it produces fixes
// for every lead, not only the ~56% that have a matched chat. The separate
// "AI Status" feature (refresh-urgent-statuses) is the one that reads the chat.
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
import { canonicalService } from "../_shared/service-names.ts";

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// A customer waiting on a dispatch decision should not be watching a spinner
// for long. gpt-4o-mini answers this in a couple of seconds; anything much
// past that means something is wrong and we should say so rather than hang.
const REQUEST_TIMEOUT_MS = 8_000;

// -----------------------------------------------------------------------------
// The cleanup brief. Form-only: no transcript, no contradiction checks.
// -----------------------------------------------------------------------------
const SYSTEM_PROMPT = `You clean up a handyman or tradesperson job FORM before the job is given urgent dispatch priority. You are given the saved RECORD only — there is no customer conversation to compare against. Propose one-click corrections to formatting problems in the form, and flag required details that are missing. Never invent information.

## What "urgent" means here
Urgent is dispatch priority. It does NOT move the agreed schedule and it does NOT make the job happen faster. Do not flag anything about timing, dates, or arrival windows.

## Corrections ("fixes")
Propose corrections to these form fields ONLY: customer_name, address, city, state, zip_code, service_type.
Cover: spelling, grammar, capitalization, formatting, city/state details, and whether service_type is a sensible, correctly named service for the recorded work.

NEVER propose a change to service_details or to any schedule field. The service description must keep its original wording.

Rules for fixes:
- "current" is the exact recorded value. "suggested" must be different from it and clearly better.
- Only suggest a value you can derive confidently from what is already on the form (e.g. fix the capitalization of a city that is already written, or derive the 2-letter state from a full state name already present). Never guess a value the form does not imply.
- state must be a 2-letter uppercase US state code. zip_code must be 5 digits (or ZIP+4). service_type must be a plain service name such as "Garage Door Repair".
- Do not "correct" a value that is already correct. Ordinary already-correct text is not a finding.
- Return an empty fixes array when the form is already clean. An empty result is a good outcome; do not pad it.

## Missing details ("flags")
If a required detail (customer name, service address, or service type) is missing, or cannot be confidently filled from the form, add it to "flags" with a short message so staff fill it in. Never invent it.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixes", "flags", "summary"],
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "current", "suggested", "reason", "kind"],
        properties: {
          field: { type: "string", enum: ["customer_name", "address", "city", "state", "zip_code", "service_type"] },
          current: { type: "string", description: "Exact recorded value." },
          suggested: { type: "string", description: "The corrected value." },
          reason: { type: "string", description: "Few words: why." },
          kind: {
            type: "string",
            enum: ["spelling", "grammar", "capitalization", "formatting", "location", "service_type", "missing_detail"],
          },
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
          field: { type: "string", enum: ["customer_name", "address", "city", "state", "zip_code", "service_type"] },
          message: { type: "string", description: "One short sentence for staff." },
        },
      },
    },
    summary: {
      type: "string",
      description: "One sentence, or a few words when there is nothing to change.",
    },
  },
} as const;

// Fields the AI may propose changes to. service_details and every schedule
// field are deliberately absent. apply_urgent_form_fixes() enforces the same
// list in the database.
const FIX_FIELDS = ["customer_name", "address", "city", "state", "zip_code", "service_type"] as const;

type FixField = (typeof FIX_FIELDS)[number];

type Fix = { field: FixField; current: string; suggested: string; reason: string; kind: string };
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
        "service_type, service_details, number_name",
    )
    .eq("id", leadId)
    .maybeSingle();

  if (leadError) return jsonResponse({ error: leadError.message }, 400);
  if (!lead) return jsonResponse({ error: "Lead not found, or you do not have access to it." }, 404);

  const leadRecord = lead as unknown as Record<string, unknown>;

  // The form, as data for the model. service_details is included for context so
  // the model can judge whether service_type matches the work — it is never a
  // field the model may change.
  const record = [
    `Customer name: ${text(lead.customer_name) || "(empty)"}`,
    `Address: ${text(lead.address) || "(empty)"}`,
    `City: ${text(lead.city) || "(empty)"}`,
    `State: ${text(lead.state) || "(empty)"}`,
    `Zip code: ${text(lead.zip_code) || "(empty)"}`,
    `Service type: ${text(lead.service_type) || "(empty)"}`,
    `Service details (CONTEXT ONLY — never change): ${text(lead.service_details) || "(empty)"}`,
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
        max_tokens: 800,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "urgent_form_cleanup",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `JOB FORM TO CLEAN UP\n\n${record}\n\n` +
              `Propose only corrections you are confident about from the form itself. ` +
              `Return empty arrays if the form is already clean.`,
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
      const f = (entry ?? {}) as Record<string, unknown>;
      const field = text(f.field) as FixField;
      if (!FIX_FIELDS.includes(field) || fixedFields.has(field)) continue;

      const stored = text(leadRecord[field]);
      let suggested = text(f.suggested).trim();
      if (!suggested || suggested.length > 200 || suggested === stored.trim()) continue;

      if (field === "state") {
        suggested = suggested.toUpperCase();
        if (!/^[A-Z]{2}$/.test(suggested)) continue;
      }
      if (field === "zip_code" && !/^\d{5}(-\d{4})?$/.test(suggested)) continue;
      if (field === "service_type") {
        const canonical = canonicalService(suggested);
        if (!canonical) {
          flags.push({
            field,
            message: "The service may not match what the customer asked for. Please check it.",
          });
          continue;
        }
        if (canonical === stored.trim()) continue;
        suggested = canonical;
      }

      fixedFields.add(field);
      fixes.push({
        field,
        // The exact stored value, so the database can detect a stale suggestion.
        current: stored,
        suggested,
        reason: text(f.reason).slice(0, 120),
        kind: text(f.kind),
      });
    }

    const flaggedFields = new Set(flags.map((f) => f.field as string));
    for (const entry of Array.isArray(parsed.flags) ? parsed.flags : []) {
      const f = (entry ?? {}) as Record<string, unknown>;
      const field = text(f.field) as FixField;
      if (!FIX_FIELDS.includes(field) || flaggedFields.has(field) || fixedFields.has(field)) continue;
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
      // No chat in this phase, so no contradiction findings.
      issues: [],
      fixes,
      flags,
      required_missing: required,
      notice: null,
      requires_acknowledgement: false,
      requires_review: false,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      conversation_found: false,
      matched_by: null,
      message_count: 0,
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
        conversation_found: false,
        matched_by: null,
        message_count: 0,
        model: MODEL,
        elapsed_ms: Date.now() - startedAt,
      },
      200,
    );
  } finally {
    clearTimeout(timer);
  }
});
