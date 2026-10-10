import { supabase } from "@/integrations/supabase/client";
import { normalizePhoneE164 } from "@/lib/phone";
import { getQuoChatUrl, isTechLineNumber } from "@/lib/quo-dashboard";

/** Resolve only an exact technician participant on the technician communications line. */
export async function resolveTechPhotoChat(phone: string): Promise<string> {
  const normalized = normalizePhoneE164(phone);
  if (!normalized) throw new Error("Select a technician with a valid phone number.");
  const digits = normalized.replace(/\D/g, "").slice(-10);
  const { data, error } = await supabase.from("quo_conversations")
    .select("quo_conversation_id, customer_number, quo_phone_numbers(quo_phone_number_id, number, display_number)")
    .or(`customer_number.eq.${normalized},customer_number.ilike.%${digits}`)
    .order("last_message_time", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  const conversation = data?.find((row) =>
    normalizePhoneE164(row.customer_number ?? "") === normalized &&
    isTechLineNumber(row.quo_phone_numbers?.number || row.quo_phone_numbers?.display_number) &&
    row.quo_conversation_id && row.quo_phone_numbers?.quo_phone_number_id,
  );
  if (!conversation) {
    throw new Error("No technician Quo conversation found. Open this technician's chat on the technician communications line in Quo, then try again.");
  }
  return getQuoChatUrl(conversation.quo_conversation_id, normalized, conversation.quo_phone_numbers?.quo_phone_number_id);
}

/** Hand original photos to Donut; Quo's own Send button completes delivery. */
export function prepareTechPhotos(chatUrl: string, photoUrls: string[]): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin ||
        event.data?.action !== "QUO_PREPARE_PHOTOS_RESPONSE" || event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.success) resolve();
      else reject(new Error(event.data.error || "Could not attach photos in Quo."));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Donut did not respond. Install/reload the latest extension and refresh the CRM and Quo tabs. Check Quo before retrying."));
    }, 60000);
    window.addEventListener("message", onMessage);
    window.postMessage({ action: "QUO_PREPARE_PHOTOS", requestId, chatUrl, photoUrls }, window.location.origin);
  });
}
