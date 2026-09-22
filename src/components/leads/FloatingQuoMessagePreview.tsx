import React, { useEffect, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { formatLocalRelativeTime } from "@/lib/quo-dashboard";
import { realtimeBus } from "@/lib/realtime";

interface FloatingQuoMessagePreviewProps {
  phone?: string | null;
  leadId?: string;
}

interface LatestMessage {
  id: string;
  text: string;
  sender: string;
  direction?: string;
  createdAt: string;
  media?: any[];
  status?: string;
}

import { extractTranscriptFromPayload } from "@/lib/quo-chat";

export default function FloatingQuoMessagePreview({ phone }: FloatingQuoMessagePreviewProps) {
  const { role, canAccess } = useAuth();
  const hasQuickChatAccess = canAccess("quick_chat");
  const [messages, setMessages] = useState<LatestMessage[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!hasQuickChatAccess || !phone) return;

    const digits = phone.replace(/\D/g, "");
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    if (!last10) return;

    let active = true;

    const fetchLatestMessages = async () => {
      const { data: convs } = await supabase
        .from("quo_conversations")
        .select("id")
        .or(`customer_number.eq.${phone},customer_number.ilike.%${last10}`)
        .order("last_message_time", { ascending: false, nullsFirst: false })
        .limit(1);

      if (!convs || convs.length === 0) return;
      const convId = convs[0].id;

      const { data: msgRows } = await supabase
        .from("quo_messages")
        .select("id, sender, text, direction, message_time, created_at, media, status, raw_payload")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: false })
        .limit(2);

      if (msgRows && active) {
        const formatted = msgRows.map((r: any) => ({
          id: r.id,
          text: r.text || extractTranscriptFromPayload(r.raw_payload) || "",
          sender: r.sender || "customer",
          direction: r.direction || "inbound",
          createdAt: r.message_time || r.created_at,
          media: r.media,
          status: r.status,
        }));
        setMessages(formatted);
      }
    };

    void fetchLatestMessages();

    const handleNewMessage = () => {
      void fetchLatestMessages();
    };

    realtimeBus.addEventListener("quo_messages", handleNewMessage);

    return () => {
      active = false;
      realtimeBus.removeEventListener("quo_messages", handleNewMessage);
    };
  }, [hasQuickChatAccess, phone]);

  if (!hasQuickChatAccess || !phone || messages.length === 0) return null;

  const visibleMessages = messages.filter((m) => !dismissedIds.has(m.id));
  if (visibleMessages.length === 0) return null;

  const handleDismiss = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setDismissedIds((prev) => new Set(prev).add(id));
  };

  return (
    <div className="absolute -left-2 top-3 z-30 flex flex-col gap-2 max-w-[210px] pointer-events-auto -translate-x-full hidden md:flex">
      {visibleMessages.map((msg) => {
        const isOutbound = msg.sender === "agent" || msg.direction === "outbound";

        return (
          <div
            key={msg.id}
            className="group relative flex items-start gap-2 rounded-xl border bg-background/95 p-2.5 text-xs text-foreground shadow-lg backdrop-blur-md transition-all hover:scale-105"
          >
            <div className="mt-0.5 shrink-0">
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 pr-3">
              <p className="line-clamp-2 font-medium leading-snug whitespace-pre-wrap break-words">
                {msg.text || (msg.media && msg.media.length > 0 ? (msg.media[0].type?.startsWith("audio") || msg.media[0].mime_type?.startsWith("audio") ? "[ 🎵 Audio ]" : "[ 📷 Image ]") : (msg.status ? `[ ${(msg.status as string).replace(/\./g, ' ')} ]` : "—"))}
              </p>
              <span className="mt-1 block text-[9px] font-medium text-muted-foreground">
                {formatLocalRelativeTime(msg.createdAt, true)} • {isOutbound ? "You" : "Customer"}
              </span>
            </div>

            {/* Dismiss Cross Button */}
            <button
              type="button"
              onClick={(e) => handleDismiss(msg.id, e)}
              className="absolute right-1.5 top-1.5 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="Dismiss preview"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
