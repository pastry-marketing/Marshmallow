import React, { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Loader2, Send, MessageSquare, User, Phone, CheckCheck, Clock, ChevronDown, Sparkles, X, ShieldAlert, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import {
  fetchReplySuggestions,
  canUseReplySuggestions,
  type ReplySuggestion,
} from "@/lib/ai/reply-suggestions";
import {
  fetchConversationTriage,
  canUseTriage,
  TRIAGE_INTENT_LABELS,
  TRIAGE_URGENCY_LABELS,
  TRIAGE_URGENCY_CLASS,
  type ConversationTriage,
} from "@/lib/ai/conversation-triage";
import {
  fetchSpamCheck,
  canUseSpamDetection,
  SPAM_VERDICT_LABEL,
  SPAM_VERDICT_CLASS,
  type SpamCheck,
} from "@/lib/ai/spam-detection";
import {
  fetchCallActionItems,
  canUseCallActionItems,
  ACTION_PRIORITY_CLASS,
  type CallActionItems,
} from "@/lib/ai/call-action-items";
import {
  formatEasternTime,
  formatLocalRelativeTime,
  formatUsPhone,
  getQuoChatUrl,
  sendQuoMessageViaExtension,
  scheduleQuoMessageViaExtension,
  normalizeQuoLeadStatus,
  QUO_LEAD_STATUS_CONFIG,
  type QuoLeadStatus,
} from "@/lib/quo-dashboard";
import { extractTranscriptFromPayload } from "@/lib/quo-chat";
import ImageLightbox from "@/components/leads/ImageLightbox";

interface MessageItem {
  id: string;
  sender: string;
  text: string | null;
  direction?: string | null;
  message_time: string | null;
  created_at?: string;
  media?: any[];
  status?: string | null;
}

interface QuoChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: {
    id: string;
    customer_name?: string | null;
    customer_number?: string | null;
    number_name?: string | null;
    status?: string | null;
    agent_name?: string | null;
  } | null;
  onStatusChange?: (newStatus: QuoLeadStatus) => void;
}

export default function QuoChatDialog({
  open,
  onOpenChange,
  conversation,
  onStatusChange,
}: QuoChatDialogProps) {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customScheduleTime, setCustomScheduleTime] = useState("");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<string[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // AI reply suggestions (roadmap feature 01). Advisory: a draft loads into the
  // composer for the agent to edit and send — this never sends on its own.
  const { role } = useAuth();
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<ReplySuggestion[]>([]);
  const [suggestNote, setSuggestNote] = useState("");
  const showSuggestButton = canUseReplySuggestions(role);

  // AI conversation triage (roadmap feature 02). Advisory: the suggestion is
  // shown; the agent decides whether to act on it.
  const [triaging, setTriaging] = useState(false);
  const [triage, setTriage] = useState<ConversationTriage | null>(null);
  const showTriageButton = canUseTriage(role);

  // AI spam/scam detection (roadmap feature 08). Advisory flag for staff review.
  const [spamChecking, setSpamChecking] = useState(false);
  const [spamCheck, setSpamCheck] = useState<SpamCheck | null>(null);
  const showSpamButton = canUseSpamDetection(role);

  // AI call action items (roadmap feature 09). Advisory follow-up checklist.
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actionItems, setActionItems] = useState<CallActionItems | null>(null);
  const showActionsButton = canUseCallActionItems(role);

  // Fetch messages when conversation changes or opens
  useEffect(() => {
    if (!open || !conversation?.id) return;

    // A different chat is open now — clear any AI output from the previous one.
    setSuggestions([]);
    setSuggestNote("");
    setTriage(null);
    setSpamCheck(null);
    setActionItems(null);

    let isCancelled = false;

    const fetchMessages = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("quo_messages")
          .select("id, sender, text, direction, message_time, created_at, media, status, raw_payload")
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: true });

        if (error) {
          console.error("Error fetching messages for chat", error);
        } else if (!isCancelled && data) {
          const formatted = data.map((r: any) => ({
            ...r,
            text: r.text || extractTranscriptFromPayload(r.raw_payload) || ""
          }));
          setMessages(formatted as MessageItem[]);
        }
      } catch (err) {
        console.error("Failed to load messages", err);
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    fetchMessages();

    // Subscribe to realtime message updates
    const channel = supabase
      .channel(`chat_${conversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "quo_messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const newMsg = payload.new as MessageItem;
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
        }
      )
      .subscribe();

    return () => {
      isCancelled = true;
      supabase.removeChannel(channel);
    };
  }, [open, conversation?.id]);

  // Auto-scroll to bottom of message thread when messages load/update
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!newMessage.trim() || !conversation?.id || sending) return;

    const textToSend = newMessage.trim();
    setNewMessage("");
    setSending(true);

    const nowIso = new Date().toISOString();
    const tempId = `temp_${Date.now()}`;

    // Optimistically append message to local state
    const optimisticMsg: MessageItem = {
      id: tempId,
      sender: "agent",
      direction: "outbound",
      text: textToSend,
      message_time: nowIso,
      created_at: nowIso,
    };

    setMessages((prev) => [...prev, optimisticMsg]);

    const chatUrl = getQuoChatUrl(
      (conversation as any).quo_conversation_id,
      conversation.customer_number,
      (conversation as any).quo_phone_number_id
    );

    // Save message to Supabase database
    try {
      const { error } = await supabase.from("quo_messages").insert({
        conversation_id: conversation.id,
        sender: "agent",
        direction: "outbound",
        text: textToSend,
        message_time: nowIso,
        quo_message_id: `msg_web_${Date.now()}`,
      });

      if (!error) {
        await supabase
          .from("quo_conversations")
          .update({
            last_message_preview: textToSend,
            last_message_at: nowIso,
            last_message_time: nowIso,
            last_agent_message_at: nowIso,
          })
          .eq("id", conversation.id);
      }
    } catch (dbErr) {
      console.warn("DB save warning:", dbErr);
    }

    // Trigger Chrome Extension message and wait for QUO_SEND_MESSAGE_RESPONSE callback
    const toastId = toast.loading("Sending via QUO Extension...");

    try {
      const extRes = await sendQuoMessageViaExtension(chatUrl, textToSend);

      if (extRes.success) {
        toast.success("Success! The message was pasted and sent via QUO.", { id: toastId });
      } else {
        toast.error(`Extension notice: ${extRes.error || "Failed to complete send"}`, { id: toastId });
      }
    } catch (err: any) {
      toast.error(`Extension notice: ${err?.message || "Extension dispatch error"}`, { id: toastId });
    } finally {
      setSending(false);
    }
  };

  const handleScheduleMessage = async (scheduleTime: string) => {
    if (!newMessage.trim() || !conversation?.id || sending) return;

    const textToSend = newMessage.trim();
    setNewMessage("");
    setCustomScheduleTime("");
    setScheduleOpen(false);
    setSending(true);

    const chatUrl = getQuoChatUrl(
      (conversation as any).quo_conversation_id,
      conversation.customer_number,
      (conversation as any).quo_phone_number_id
    );

    const toastId = toast.loading(`Scheduling message for "${scheduleTime}" via Extension...`);

    try {
      const extRes = await scheduleQuoMessageViaExtension(chatUrl, textToSend, scheduleTime);

      if (extRes.success) {
        toast.success(`Success! Message scheduled for "${scheduleTime}".`, { id: toastId });
      } else {
        toast.error(`Failed to schedule: ${extRes.error || "Cancelled"}`, { id: toastId });
      }
    } catch (err: any) {
      toast.error(`Failed to schedule: ${err?.message || "Extension error"}`, { id: toastId });
    } finally {
      setSending(false);
    }
  };

  const handleSuggestReply = async () => {
    if (!conversation?.id || suggesting) return;
    setSuggesting(true);
    setSuggestNote("");
    try {
      const result = await fetchReplySuggestions(conversation.id);
      setSuggestions(result.suggestions);
      setSuggestNote(result.note);
      if (result.suggestions.length === 0 && !result.note) {
        toast.message("No reply suggestions for this chat.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not draft a reply.");
    } finally {
      setSuggesting(false);
    }
  };

  const applySuggestion = (text: string) => {
    setNewMessage(text);
    setSuggestions([]);
    setSuggestNote("");
  };

  const handleTriage = async () => {
    if (!conversation?.id || triaging) return;
    setTriaging(true);
    try {
      setTriage(await fetchConversationTriage(conversation.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not triage this chat.");
    } finally {
      setTriaging(false);
    }
  };

  const handleSpamCheck = async () => {
    if (!conversation?.id || spamChecking) return;
    setSpamChecking(true);
    try {
      setSpamCheck(await fetchSpamCheck(conversation.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run the spam check.");
    } finally {
      setSpamChecking(false);
    }
  };

  const handleActionItems = async () => {
    if (!conversation?.id || actionsLoading) return;
    setActionsLoading(true);
    try {
      const res = await fetchCallActionItems(conversation.id);
      setActionItems(res);
      if (res.items.length === 0) toast.message(res.summary || "No follow-ups found.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not extract action items.");
    } finally {
      setActionsLoading(false);
    }
  };

  if (!conversation) return null;

  const currentStatusKey = normalizeQuoLeadStatus(conversation.status);
  const statusCfg = QUO_LEAD_STATUS_CONFIG[currentStatusKey];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[580px] h-[85vh] max-h-[680px] p-0 flex flex-col overflow-hidden glass-panel-strong border-border/80 shadow-2xl">
        {/* Chat Header */}
        <DialogHeader className="p-4 border-b border-border/50 bg-muted/30 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary font-semibold text-sm">
                <MessageSquare className="h-5 w-5" />
              </span>
              <div>
                <DialogTitle className="text-base font-semibold tracking-tight text-foreground flex items-center gap-2">
                  <span>{formatUsPhone(conversation.customer_number)}</span>
                  {conversation.customer_name && (
                    <span className="text-xs font-normal text-muted-foreground">
                      ({conversation.customer_name})
                    </span>
                  )}
                </DialogTitle>
                <div className="flex items-center gap-2 mt-1">
                  {conversation.number_name && (
                    <span className="text-xs font-medium text-muted-foreground">
                      {conversation.number_name}
                    </span>
                  )}
                  <Badge
                    variant="outline"
                    className={`text-[11px] font-semibold ${statusCfg.badgeClass}`}
                  >
                    {statusCfg.label}
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Messages Body */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 space-y-3.5 bg-background/40"
        >
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground gap-2 text-xs">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Loading chat messages...
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-1 text-xs">
              <MessageSquare className="h-8 w-8 text-muted-foreground/40 mb-1" />
              <span>No messages in this chat yet.</span>
            </div>
          ) : (
            messages.map((msg) => {
              const isOutbound =
                msg.sender === "agent" ||
                msg.direction === "outbound" ||
                msg.sender === "us";

              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${
                    isOutbound ? "items-end" : "items-start"
                  }`}
                >
                  <div
                    className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm shadow-sm leading-relaxed ${
                      isOutbound
                        ? "bg-primary text-primary-foreground rounded-br-xs"
                        : "bg-muted/90 text-foreground border border-border/50 rounded-bl-xs"
                    }`}
                  >
                    {msg.media && msg.media.length > 0 && (
                      <div className="flex flex-col gap-2 mb-2">
                        {msg.media.map((mediaItem, idx) => {
                          const isAudio = mediaItem.type?.startsWith("audio") || mediaItem.mime_type?.startsWith("audio");
                          const isImage = mediaItem.type?.startsWith("image") || mediaItem.mime_type?.startsWith("image");
                          const url = mediaItem.url || mediaItem.src;
                          if (!url) return null;

                          if (isAudio) {
                            return (
                              <audio
                                key={idx}
                                controls
                                src={url}
                                className="w-full max-w-[240px] h-10"
                                preload="metadata"
                              />
                            );
                          } else if (isImage) {
                            return (
                              <img
                                key={idx}
                                src={url}
                                alt="MMS attachment"
                                className="w-48 h-auto max-h-48 object-cover rounded-md cursor-pointer hover:opacity-90 transition-opacity border border-white/20 shadow-sm"
                                onClick={() => {
                                  // collect all images in conversation
                                  const allImages: string[] = [];
                                  let clickedIndex = 0;
                                  messages.forEach((m) => {
                                    if (m.media) {
                                      m.media.forEach((mi) => {
                                        if ((mi.type?.startsWith("image") || mi.mime_type?.startsWith("image")) && (mi.url || mi.src)) {
                                          if ((mi.url || mi.src) === url) clickedIndex = allImages.length;
                                          allImages.push(mi.url || mi.src);
                                        }
                                      });
                                    }
                                  });
                                  setLightboxImages(allImages);
                                  setLightboxIndex(clickedIndex);
                                  setLightboxOpen(true);
                                }}
                              />
                            );
                          }
                          return null;
                        })}
                      </div>
                    )}
                    {msg.text && (
                      <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                    )}
                    {!msg.text && (!msg.media || msg.media.length === 0) && (
                      <p className="whitespace-pre-wrap break-words italic opacity-70">
                        {msg.status ? `[ ${msg.status.replace(/\./g, ' ')} ]` : "—"}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1 px-1 text-[10px] text-muted-foreground">
                    <span>
                      {formatLocalRelativeTime(
                        msg.message_time || msg.created_at,
                        true
                      )}
                    </span>
                    {isOutbound && <CheckCheck className="h-3 w-3 text-primary/70" />}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* AI assist (advisory). Reply suggestions load a draft into the
            composer; triage suggests how to sort the chat. Both are shown to
            the agent, who decides — nothing is sent or saved automatically. */}
        {(showSuggestButton || showTriageButton || showSpamButton || showActionsButton) && (
          <div className="px-3 pt-2 border-t border-border/40 bg-background/60 shrink-0 max-h-[40vh] overflow-y-auto">
            {actionItems && actionItems.items.length > 0 && (
              <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                    <ListChecks className="h-3 w-3 text-primary" /> Suggested follow-ups
                  </span>
                  <button
                    type="button"
                    onClick={() => setActionItems(null)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Dismiss action items"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <ul className="space-y-1">
                  {actionItems.items.map((it, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[11px]">
                      <Badge variant="outline" className={`mt-0.5 shrink-0 text-[9px] font-semibold ${ACTION_PRIORITY_CLASS[it.priority]}`}>
                        {it.priority}
                      </Badge>
                      <span className="text-foreground">
                        {it.action}
                        {it.owner === "customer" && (
                          <span className="text-muted-foreground"> · waiting on customer</span>
                        )}
                        {it.timing && <span className="text-muted-foreground"> · {it.timing}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {spamCheck && (
              <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                    <ShieldAlert className="h-3 w-3 text-primary" /> Spam / scam check
                  </span>
                  <button
                    type="button"
                    onClick={() => setSpamCheck(null)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Dismiss spam check"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className={`text-[10px] font-semibold ${SPAM_VERDICT_CLASS[spamCheck.verdict]}`}>
                    {SPAM_VERDICT_LABEL[spamCheck.verdict]}
                  </Badge>
                  <span className="text-[10px] font-medium text-muted-foreground">risk {spamCheck.risk}/100</span>
                </div>
                {spamCheck.signals.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {spamCheck.signals.map((s, i) => (
                      <li key={i} className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {s}
                      </li>
                    ))}
                  </ul>
                )}
                {spamCheck.reason && (
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{spamCheck.reason}</p>
                )}
              </div>
            )}
            {triage && (
              <div className="mb-2 rounded-lg border border-primary/20 bg-primary/[0.04] p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                    <Sparkles className="h-3 w-3 text-primary" /> Triage suggestion
                  </span>
                  <button
                    type="button"
                    onClick={() => setTriage(null)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Dismiss triage"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className={`text-[10px] font-semibold ${QUO_LEAD_STATUS_CONFIG[normalizeQuoLeadStatus(triage.status)].badgeClass}`}
                  >
                    {QUO_LEAD_STATUS_CONFIG[normalizeQuoLeadStatus(triage.status)].label}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px] font-medium">
                    {TRIAGE_INTENT_LABELS[triage.intent] ?? triage.intent}
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] font-medium ${TRIAGE_URGENCY_CLASS[triage.urgency]}`}>
                    {TRIAGE_URGENCY_LABELS[triage.urgency]}
                  </Badge>
                  {triage.serviceType && (
                    <Badge variant="outline" className="text-[10px] font-medium border-border/70">
                      {triage.serviceType}
                    </Badge>
                  )}
                </div>
                {triage.reason && (
                  <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{triage.reason}</p>
                )}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="mb-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1">
                    <Sparkles className="h-3 w-3 text-primary" /> Suggested replies · pick one to edit
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSuggestions([]);
                      setSuggestNote("");
                    }}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Dismiss suggestions"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => applySuggestion(s.text)}
                    className="w-full text-left rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 transition-colors hover:border-primary/30 hover:bg-primary/10"
                  >
                    <span className="block text-[10px] font-semibold uppercase tracking-wide text-primary/80">
                      {s.tone}
                    </span>
                    <span className="block whitespace-pre-wrap text-xs text-foreground">{s.text}</span>
                  </button>
                ))}
              </div>
            )}
            {suggestNote && suggestions.length === 0 && (
              <p className="mb-2 text-[11px] italic text-muted-foreground">{suggestNote}</p>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {showSuggestButton && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSuggestReply}
                  disabled={suggesting || sending}
                  className="h-7 gap-1.5 text-xs text-primary hover:bg-primary/10"
                  title="Draft on-brand reply options you can edit before sending"
                >
                  {suggesting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {suggesting ? "Drafting…" : suggestions.length > 0 ? "Suggest again" : "Suggest reply"}
                </Button>
              )}
              {showTriageButton && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleTriage}
                  disabled={triaging}
                  className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  title="Suggest a status, intent, service and urgency for this chat"
                >
                  {triaging ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {triaging ? "Triaging…" : triage ? "Re-triage" : "Triage"}
                </Button>
              )}
              {showSpamButton && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSpamCheck}
                  disabled={spamChecking}
                  className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  title="Check this chat for spam or scam patterns"
                >
                  {spamChecking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldAlert className="h-3.5 w-3.5" />
                  )}
                  {spamChecking ? "Checking…" : "Spam check"}
                </Button>
              )}
              {showActionsButton && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleActionItems}
                  disabled={actionsLoading}
                  className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  title="Extract follow-up actions from this conversation and its calls"
                >
                  {actionsLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ListChecks className="h-3.5 w-3.5" />
                  )}
                  {actionsLoading ? "Reviewing…" : "Action items"}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Chat Input Footer */}
        <form
          onSubmit={handleSendMessage}
          className="p-3 border-t border-border/50 bg-background/80 flex items-end gap-2 shrink-0"
        >
          <Textarea
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder="Type a message to append to chat thread..."
            className="flex-1 min-h-[44px] max-h-[100px] resize-none text-xs bg-muted/30 focus-visible:ring-1 focus-visible:ring-primary/40 border-border/60"
          />
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              type="submit"
              disabled={!newMessage.trim() || sending}
              size="sm"
              className="h-[44px] px-4 gap-1.5 font-medium"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  <span>Send</span>
                </>
              )}
            </Button>

            {/* Schedule Message Popover */}
            <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!newMessage.trim() || sending}
                  className="h-[44px] px-3 gap-1.5 border-border/80 bg-background/80 hover:bg-muted text-xs font-medium"
                  title="Schedule message for later via Chrome Extension"
                >
                  <Clock className="h-4 w-4 text-amber-400" />
                  <span className="hidden sm:inline">Schedule</span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[300px] p-3 space-y-3 glass-panel-strong border-border/80 shadow-2xl">
                <div className="flex items-center justify-between border-b border-border/40 pb-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <Clock className="h-4 w-4 text-amber-400" />
                    <span>Schedule Message</span>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">Quo Extension</Badge>
                </div>

                {/* Quick Presets */}
                <div className="space-y-1">
                  <p className="text-[11px] font-medium text-muted-foreground">Quick Presets</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs justify-start border-border/60 hover:bg-muted/60"
                      onClick={() => handleScheduleMessage("tomorrow at 9am")}
                    >
                      Tomorrow 9:00 AM
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs justify-start border-border/60 hover:bg-muted/60"
                      onClick={() => handleScheduleMessage("tomorrow at 5pm")}
                    >
                      Tomorrow 5:00 PM
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs justify-start border-border/60 hover:bg-muted/60"
                      onClick={() => handleScheduleMessage("in 1 hour")}
                    >
                      In 1 Hour
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs justify-start border-border/60 hover:bg-muted/60"
                      onClick={() => handleScheduleMessage("in 2 hours")}
                    >
                      In 2 Hours
                    </Button>
                  </div>
                </div>

                {/* Custom Time Input */}
                <div className="space-y-1.5 pt-1 border-t border-border/40">
                  <label className="text-[11px] font-medium text-muted-foreground">Custom Time Description</label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={customScheduleTime}
                      onChange={(e) => setCustomScheduleTime(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && customScheduleTime.trim()) {
                          e.preventDefault();
                          handleScheduleMessage(customScheduleTime.trim());
                        }
                      }}
                      placeholder="e.g. tomorrow at 5pm"
                      className="h-8 text-xs bg-muted/30"
                    />
                    <Button
                      size="sm"
                      disabled={!customScheduleTime.trim()}
                      onClick={() => handleScheduleMessage(customScheduleTime.trim())}
                      className="h-8 text-xs px-3 bg-amber-600 hover:bg-amber-700 text-white shrink-0 font-medium"
                    >
                      Schedule
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </form>
        {/* Image Lightbox */}
        <ImageLightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
        />
      </DialogContent>
    </Dialog>
  );
}
