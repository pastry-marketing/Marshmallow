import { invokeAi } from "./invoke";

// =============================================================================
// AI Lead Auto-Fill (roadmap Tier 2 / feature 04) — client side.
//
// Extracts lead-form fields from a customer's chat so there is less to type and
// fewer missed details. The returned values are suggestions: the caller pre-fills
// empty form fields and the person reviews and edits before saving. Values the
// chat did not establish come back as empty strings — never invented.
// =============================================================================

export type LeadAutofillFields = {
  customer_name: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  service_type: string;
  service_details: string;
  urgency: "low" | "medium" | "high";
  preferred_time: string;
};

export type LeadAutofillResult = {
  fields: LeadAutofillFields;
  found: boolean;
  messageCount: number;
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseLeadAutofill(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

const EMPTY: LeadAutofillFields = {
  customer_name: "",
  address: "",
  city: "",
  state: "",
  zip_code: "",
  service_type: "",
  service_details: "",
  urgency: "low",
  preferred_time: "",
};

/** Combine the separate location parts into one address line for a form that
 *  has a single address field. Returns "" when there is nothing to compose. */
export function composeAddress(fields: LeadAutofillFields): string {
  const tail = [fields.city, [fields.state, fields.zip_code].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [fields.address, tail].filter(Boolean).join(", ");
}

export async function fetchLeadAutofill(input: {
  conversationId?: string;
  phone?: string;
  leadId?: string;
}): Promise<LeadAutofillResult> {
  const body: Record<string, unknown> = {};
  if (input.conversationId) body.conversationId = input.conversationId;
  if (input.leadId) body.leadId = input.leadId;
  if (input.phone) body.phone = input.phone;
  if (Object.keys(body).length === 0) throw new Error("Provide a conversation, lead, or phone.");

  const res = await invokeAi<{ fields?: Partial<LeadAutofillFields>; found?: boolean; message_count?: number }>(
    "ai-lead-autofill",
    body,
  );
  if (!res.ok) throw new Error(res.message);

  const raw = (res.data?.fields ?? {}) as Partial<LeadAutofillFields>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const urgency = (["low", "medium", "high"] as const).includes(raw.urgency as LeadAutofillFields["urgency"])
    ? (raw.urgency as LeadAutofillFields["urgency"])
    : "low";

  return {
    fields: {
      ...EMPTY,
      customer_name: str(raw.customer_name),
      address: str(raw.address),
      city: str(raw.city),
      state: str(raw.state),
      zip_code: str(raw.zip_code),
      service_type: str(raw.service_type),
      service_details: str(raw.service_details),
      urgency,
      preferred_time: str(raw.preferred_time),
    },
    found: res.data?.found === true,
    messageCount: typeof res.data?.message_count === "number" ? res.data.message_count : 0,
  };
}
