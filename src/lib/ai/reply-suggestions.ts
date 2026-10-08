import { invokeAi } from "./invoke";

// =============================================================================
// AI Reply Suggestions (roadmap Tier 1 / feature 01) — client side.
//
// Asks the ai-reply-suggestions function for a few on-brand draft replies to the
// current customer conversation. The drafts are advisory: the agent clicks one
// to load it into the composer, edits it, and sends it themselves.
// =============================================================================

export type ReplySuggestion = { text: string; tone: string };

export type ReplySuggestionsResult = {
  suggestions: ReplySuggestion[];
  note: string;
  messageCount: number;
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

/** The roles the edge function accepts — gate the UI so nobody sees a 403. */
export function canUseReplySuggestions(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

export async function fetchReplySuggestions(conversationId: string): Promise<ReplySuggestionsResult> {
  if (!conversationId) throw new Error("Missing conversation.");

  const res = await invokeAi<{
    suggestions?: unknown;
    note?: unknown;
    message_count?: unknown;
  }>("ai-reply-suggestions", { conversationId });

  if (!res.ok) throw new Error(res.message);

  const rawSuggestions = Array.isArray(res.data.suggestions) ? res.data.suggestions : [];
  const suggestions: ReplySuggestion[] = [];
  for (const entry of rawSuggestions) {
    const s = (entry ?? {}) as Record<string, unknown>;
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (!text) continue;
    suggestions.push({
      text,
      tone: typeof s.tone === "string" && s.tone.trim() ? s.tone.trim() : "Suggested",
    });
  }

  return {
    suggestions,
    note: typeof res.data.note === "string" ? res.data.note : "",
    messageCount: typeof res.data.message_count === "number" ? res.data.message_count : 0,
  };
}
