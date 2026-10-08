import { invokeAi } from "./invoke";

// =============================================================================
// AI Call Action Items (roadmap Tier 3 / feature 09) — client side.
//
// Reviews a conversation (including call summaries/transcripts) and lists the
// follow-up actions it implies, so promised callbacks and next steps are not
// forgotten. Advisory — a checklist, not an actioned task list.
// =============================================================================

export type ActionOwner = "us" | "customer";
export type ActionPriority = "high" | "medium" | "low";

export type ActionItem = {
  action: string;
  owner: ActionOwner;
  timing: string;
  priority: ActionPriority;
};

export type CallActionItems = {
  items: ActionItem[];
  summary: string;
};

export const ACTION_PRIORITY_CLASS: Record<ActionPriority, string> = {
  high: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300",
  medium:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  low: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseCallActionItems(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

export async function fetchCallActionItems(conversationId: string): Promise<CallActionItems> {
  if (!conversationId) throw new Error("Missing conversation.");

  const res = await invokeAi<{ items?: unknown; summary?: unknown }>("ai-call-action-items", {
    conversationId,
  });
  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const items: ActionItem[] = rawItems
    .map((entry) => {
      const it = (entry ?? {}) as Record<string, unknown>;
      const owner: ActionOwner = it.owner === "customer" ? "customer" : "us";
      const priority: ActionPriority =
        it.priority === "high" || it.priority === "low" ? it.priority : "medium";
      return {
        action: typeof it.action === "string" ? it.action : "",
        owner,
        timing: typeof it.timing === "string" ? it.timing : "",
        priority,
      };
    })
    .filter((it) => it.action);

  return {
    items,
    summary: typeof d.summary === "string" ? d.summary : "",
  };
}
