import { supabase } from "@/integrations/supabase/client";

/**
 * A lightweight global event bus for distributing Supabase Realtime events locally
 * to avoid creating hundreds of WebSocket channels.
 */
export const realtimeBus = new EventTarget();

let isRealtimeSetup = false;
let globalChannel: ReturnType<typeof supabase.channel> | null = null;

export function setupGlobalRealtime() {
  if (isRealtimeSetup) return;
  isRealtimeSetup = true;

  // Single global channel for row-level components
  globalChannel = supabase
    .channel("global-app-events")
    // Quo Messages
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "quo_messages" },
      (payload) => {
        realtimeBus.dispatchEvent(new CustomEvent("quo_messages", { detail: payload }));
      }
    )
    // Quo Outbound Messages
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "quo_outbound_messages" },
      (payload) => {
        realtimeBus.dispatchEvent(new CustomEvent("quo_outbound_messages", { detail: payload }));
      }
    )
    // Quo Conversations
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "quo_conversations" },
      (payload) => {
        realtimeBus.dispatchEvent(new CustomEvent("quo_conversations", { detail: payload }));
      }
    )
    // Lead Notes
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "lead_notes" },
      (payload) => {
        realtimeBus.dispatchEvent(new CustomEvent("lead_notes", { detail: payload }));
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log("Global Realtime Channel Connected");
      }
      if (err) {
        console.error("Global Realtime Channel Error:", err);
      }
    });
}
