import { parseTechnicianQuoLink } from "./technician-quo-link.ts";

export type HistoryMessage = { id?: string; conversation_id: string; sender: string; text: string | null; message_time: string | null };
export type HistoryEvidence = { label?: string; quote: string; source: string; message_id?: string; message_time: string | null; conversation_id: string };

export function historyTranscript(messages: HistoryMessage[]): string {
  return messages.map((message) => {
    const date = message.message_time && Number.isFinite(Date.parse(message.message_time)) ? new Date(message.message_time).toISOString() : "time unknown";
    return `[${message.id ?? `${message.conversation_id}:${date}`}] [${date}] ${message.sender === "agent" ? "Our team" : "Technician / contact"}: ${(message.text ?? "[no text]").slice(0, 1200)}`;
  }).join("\n").slice(-100_000);
}

/** Verify exact quoted text and identity; a model cannot choose the speaker. */
export function verifyHistoryEvidence(value: unknown, messages: HistoryMessage[], labels: readonly string[]): HistoryEvidence[] {
  if (!Array.isArray(value)) return [];
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  return value.slice(0, 10).flatMap((item) => {
    if (!item || typeof item.quote !== "string" || item.quote.trim().length < 12 || !labels.includes(item.label)) return [];
    const quote = normalize(item.quote);
    const matches = messages.filter((message) => (!item.message_id || item.message_id === message.id) &&
      normalize((message.text ?? "").slice(0, 1200)).includes(quote));
    if (!matches.length || new Set(matches.map((message) => message.sender)).size > 1) return [];
    const message = matches[0];
    return [{ label: item.label, quote: item.quote.trim().slice(0, 400),
      source: message.sender === "agent" ? "Our team" : "Technician / contact",
      message_id: message.id, message_time: message.message_time, conversation_id: message.conversation_id }];
  });
}

export async function readLinkedTechnicianHistory(options: {
  chatLink: string | null; phone: string | null; apiKey?: string; apiBase?: string; fetcher?: typeof fetch;
}): Promise<{ messages: HistoryMessage[]; error: string | null; limited: boolean }> {
  const link = parseTechnicianQuoLink(options.chatLink);
  if (!link) return { messages: [], error: null, limited: false };
  const digits = (options.phone ?? "").replace(/\D/g, "");
  const participant = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  if (!participant) return { messages: [], error: "A valid technician phone number is required for the saved Quo chat.", limited: false };
  if (!options.apiKey) return { messages: [], error: "QUO_API_KEY is not configured. An Admin must add it under Supabase Edge Functions → Secrets, then retry.", limited: false };
  const messages = new Map<string, HistoryMessage>();
  let token: string | null = null;
  try {
    const base = (options.apiBase || "https://api.quo.com/v1").replace(/\/$/, "");
    const signal = AbortSignal.timeout(30000);
    for (let page = 0; page < 3; page++) {
      const params = new URLSearchParams({ phoneNumberId: link.phoneNumberId, participants: participant, maxResults: "100" });
      if (token) params.set("pageToken", token);
      const response = await (options.fetcher ?? fetch)(`${base}/messages?${params}`, { headers: { Authorization: options.apiKey, Accept: "application/json" }, signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Quo denied access. Check QUO_API_KEY and access to this phone line." : response.status === 429 ? "Quo rate limit reached. Wait briefly and retry." : `Quo history returned HTTP ${response.status}. Retry the report.`);
      const payload = await response.json();
      if (!Array.isArray(payload.data)) throw new Error("Quo returned an invalid history response.");
      for (const item of payload.data) {
        if (item.conversationId !== link.conversationId || (item.phoneNumberId && item.phoneNumberId !== link.phoneNumberId) ||
          !["incoming", "outgoing"].includes(item.direction) || typeof item.text !== "string" || !item.text.trim()) continue;
        const key = item.id || `${item.createdAt}:${item.direction}:${item.text}`;
        messages.set(key, { id: item.id, conversation_id: link.conversationId, sender: item.direction === "incoming" ? "customer" : "agent", text: item.text, message_time: item.createdAt ?? null });
      }
      token = typeof payload.nextPageToken === "string" ? payload.nextPageToken : null;
      if (!token || messages.size > 250) break;
    }
    const ordered = [...messages.values()].sort((a, b) => (a.message_time ?? "").localeCompare(b.message_time ?? ""));
    return { messages: ordered.slice(-250), error: null, limited: !!token || ordered.length > 250 };
  } catch (error) {
    return { messages: [], error: error instanceof Error ? error.message : "Quo history is unavailable. Retry or sync the saved chat.", limited: false };
  }
}
