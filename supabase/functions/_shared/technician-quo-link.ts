/** Only a saved Quo inbox URL can authorize a direct conversation lookup. */
export function parseTechnicianQuoLink(value: string | null): { phoneNumberId: string; conversationId: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "my.quo.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "inbox") return null;
    const phoneNumberId = parts.find((part) => /^PN[A-Za-z0-9_-]{6,}$/.test(part));
    const conversationId = parts.find((part) => /^CN[A-Za-z0-9_-]{6,}$/.test(part));
    return phoneNumberId && conversationId ? { phoneNumberId, conversationId } : null;
  } catch {
    return null;
  }
}
