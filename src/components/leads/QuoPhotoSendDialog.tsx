import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Send, CheckSquare, Square, Images } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { fetchAllTechnicians, TECHNICIANS_QUERY_KEY } from "@/lib/technicians";
import { normalizePhoneE164 } from "@/lib/phone";
import { resolveTechPhotoChat } from "@/lib/quo-tech-photos";
import { cn } from "@/lib/utils";
import ImageLightbox from "@/components/leads/ImageLightbox";
import {
  sendQuoAttachmentsViaExtension,
  QUO_MAX_IMAGES_PER_MESSAGE,
} from "@/lib/quo-attachments";

interface QuoPhotoSendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Storage paths for this lead's photos, in display order. */
  photoPaths: string[];
  technicianPhone?: string | null;
  technicianName?: string | null;
}

export default function QuoPhotoSendDialog({
  open,
  onOpenChange,
  photoPaths,
  technicianPhone,
  technicianName,
}: QuoPhotoSendDialogProps) {
  const [urls, setUrls] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [selectedTechId, setSelectedTechId] = useState("");
  const hasAssignedTech = Boolean(technicianPhone?.trim() || technicianName?.trim());
  const technicians = useQuery({
    queryKey: TECHNICIANS_QUERY_KEY,
    queryFn: fetchAllTechnicians,
    enabled: open && !hasAssignedTech,
  });
  const selectedTech = technicians.data?.find((tech) => tech.id === selectedTechId);
  const recipientPhone = hasAssignedTech ? technicianPhone : selectedTech?.phone_number;
  const recipientName = hasAssignedTech ? technicianName : selectedTech?.name;
  const validRecipient = normalizePhoneE164(recipientPhone ?? "");

  // Resolve signed URLs for every photo once the dialog opens. We use the
  // originals (no transform): the extension size-batches them and Quo resizes
  // for carrier limits, so quality is preserved end to end.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setUrls([]);
    setSelected(new Set());
    (async () => {
      try {
        const { getSignedUrls } = await import("@/lib/storage");
        const resolved = await getSignedUrls(photoPaths);
        if (!active) return;
        setUrls(resolved);
        setSelected(new Set(resolved.map((_, i) => i)));
      } catch (err) {
        console.error("Failed to resolve photo URLs for Quo send:", err);
        if (active) toast.error("Couldn't load photos to send.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, photoPaths]);

  const selectedCount = selected.size;
  const allSelected = selectedCount > 0 && selectedCount === urls.length;
  const messageCount = Math.ceil(selectedCount / QUO_MAX_IMAGES_PER_MESSAGE);

  const selectedUrls = useMemo(
    () => urls.filter((_, i) => selected.has(i)),
    [urls, selected],
  );

  const toggle = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === urls.length ? new Set() : new Set(urls.map((_, i) => i)),
    );
  };

  const handleSend = async () => {
    if (selectedUrls.length === 0 || !validRecipient) return;
    setSending(true);
    const toastId = toast.loading(
      `Sending ${selectedUrls.length} photo${selectedUrls.length === 1 ? "" : "s"} to technician ${recipientName || validRecipient}…`,
    );
    try {
      const chatUrl = await resolveTechPhotoChat(validRecipient);
      const res = await sendQuoAttachmentsViaExtension(chatUrl, selectedUrls, validRecipient);
      if (res.success) {
        const n = res.sent ?? selectedUrls.length;
        toast.success(
          `Sent ${n} photo${n === 1 ? "" : "s"} to technician ${recipientName || validRecipient}.`,
          { id: toastId },
        );
        onOpenChange(false);
      } else {
        let msg = res.error || "The extension could not send the photos.";
        if (msg.includes("Could not find message input editor")) {
          msg = "Couldn't find the Quo composer. Make sure a Quo tab is open and try again.";
        }
        toast.error(msg, { id: toastId });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send photos to Quo.", {
        id: toastId,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => { if (!sending) onOpenChange(nextOpen); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Images className="h-4 w-4 text-primary" />
              Send photos to technician{recipientName ? ` · ${recipientName}` : ""}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Select the photos to attach. The Donut extension drops them straight into the
              Quo composer — no copy-and-paste. Quo sends up to {QUO_MAX_IMAGES_PER_MESSAGE} images
              per message, so larger sets go out as several messages automatically.
            </DialogDescription>
          </DialogHeader>

          {hasAssignedTech ? (
            <p className="text-sm">Assigned technician: <strong>{recipientName || "Technician"}</strong> · {recipientPhone || "No phone number"}
              {!validRecipient && <span className="block text-destructive">Update the assigned technician's phone number before sending.</span>}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">No technician is assigned. Select a technician to receive these photos.</p>
              <Select value={selectedTechId} onValueChange={setSelectedTechId} disabled={sending || technicians.isLoading}>
                <SelectTrigger aria-label="Photo recipient technician"><SelectValue placeholder="Select technician" /></SelectTrigger>
                <SelectContent>
                  {technicians.data?.filter((tech) => tech.is_active !== false && normalizePhoneE164(tech.phone_number ?? "")).map((tech) => (
                    <SelectItem key={tech.id} value={tech.id}>{tech.name} · {tech.phone_number} · {tech.area}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {technicians.isError && <p className="text-sm text-destructive">Couldn't load technicians. Reopen the dialog to retry.</p>}
              {technicians.isSuccess && !technicians.data.some((tech) => tech.is_active !== false && normalizePhoneE164(tech.phone_number ?? "")) && (
                <p className="text-sm text-muted-foreground">No accessible active technicians have a valid phone number.</p>
              )}
              {selectedTech && <p className="text-xs text-muted-foreground">Photo recipient only; this does not change the lead's assignment.</p>}
            </div>
          )}

          {loading ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Loading photos…
            </div>
          ) : urls.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              No photos to send.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground"
                >
                  {allSelected ? (
                    <CheckSquare className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <Square className="h-3.5 w-3.5" />
                  )}
                  {allSelected ? "Clear all" : "Select all"}
                </button>
                <span className="text-xs text-muted-foreground">
                  {selectedCount} of {urls.length} selected
                  {messageCount > 1 ? ` · ${messageCount} messages` : ""}
                </span>
              </div>

              <div className="grid max-h-[46vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
                {urls.map((url, i) => {
                  const isSelected = selected.has(i);
                  return (
                    <div
                      key={i}
                      className={cn(
                        "group relative aspect-square overflow-hidden rounded-lg border-2 transition-colors",
                        isSelected ? "border-primary" : "border-border/50",
                      )}
                    >
                      <img
                        src={url}
                        alt={`Photo ${i + 1}`}
                        loading="lazy"
                        className="h-full w-full cursor-pointer object-cover"
                        onClick={() => {
                          setLightboxIndex(i);
                          setLightboxOpen(true);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => toggle(i)}
                        aria-label={isSelected ? `Deselect photo ${i + 1}` : `Select photo ${i + 1}`}
                        className={cn(
                          "absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border text-[10px] font-bold transition-colors",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-white/70 bg-black/40 text-transparent group-hover:text-white/70",
                        )}
                      >
                        ✓
                      </button>
                      <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/55 px-1 text-[10px] font-medium text-white">
                        {i + 1}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={sending}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSend()}
              disabled={sending || loading || selectedCount === 0 || !validRecipient}
              className="gap-1.5"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send {selectedCount > 0 ? selectedCount : ""} to technician
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImageLightbox
        images={urls}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </>
  );
}
