import { Phone, Copy, MessageCircle, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toTelHref, copyToClipboard } from "@/lib/phone";
import { toast } from "sonner";

export interface TechnicianLike {
  name: string;
  phone_number?: string | null;
  area?: string | null;
  service?: string | null;
  chat_link?: string | null;
  notes?: string | null;
  is_good_tech?: boolean | null;
}

interface Props {
  technician: TechnicianLike;
  compact?: boolean;
  onToggleGoodTech?: (isGood: boolean) => void;
}

function isValidUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function TechnicianDetailsContent({ technician, compact = false, onToggleGoodTech }: Props) {
  const phone = (technician.phone_number ?? "").trim();
  const tel = toTelHref(phone);
  const chatOk = technician.chat_link && isValidUrl(technician.chat_link.trim());

  const handleCopy = async () => {
    if (!phone) return;
    const ok = await copyToClipboard(phone);
    if (ok) toast.success("Phone number copied");
    else toast.error("Failed to copy");
  };

  const labelClass = "text-[11px] uppercase tracking-wide text-muted-foreground";
  const valueClass = "text-sm text-foreground break-words";

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div>
        <div className="flex items-center gap-1.5">
          <div className="text-base font-semibold text-foreground break-words">{technician.name}</div>
          {onToggleGoodTech ? (
            <button
              onClick={() => onToggleGoodTech(!technician.is_good_tech)}
              className="hover:scale-110 transition-transform focus:outline-none"
              title={technician.is_good_tech ? "Mark as normal tech" : "Mark as Good Tech"}
            >
              <Star className={`h-4 w-4 transition-colors ${technician.is_good_tech ? "fill-amber-500 text-amber-500" : "text-muted-foreground/30 hover:text-muted-foreground"}`} />
            </button>
          ) : technician.is_good_tech ? (
            <Star className="h-4 w-4 fill-amber-500 text-amber-500" title="Good Tech" />
          ) : null}
        </div>
      </div>

      <div className="space-y-1">
        <div className={labelClass}>Phone</div>
        {phone ? (
          <>
            <a href={tel ?? undefined} className="text-sm font-medium text-primary hover:underline break-all">
              {phone}
            </a>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {tel && (
                <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                  <a href={tel}><Phone className="mr-1 h-3 w-3" /> Call Tech</a>
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleCopy}>
                <Copy className="mr-1 h-3 w-3" /> Copy Phone
              </Button>
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">No phone number</div>
        )}
      </div>

      {technician.service && (
        <div className="space-y-0.5">
          <div className={labelClass}>Service</div>
          <div className={valueClass}>{technician.service}</div>
        </div>
      )}

      {technician.area && (
        <div className="space-y-0.5">
          <div className={labelClass}>Area</div>
          <div className={valueClass}>{technician.area}</div>
        </div>
      )}

      {technician.notes && (
        <div className="space-y-0.5">
          <div className={labelClass}>Notes</div>
          <div className={`${valueClass} whitespace-pre-wrap`}>{technician.notes}</div>
        </div>
      )}

      {chatOk && (
        <div className="pt-1">
          <Button asChild size="sm" variant="secondary" className="h-7 text-xs">
            <a href={technician.chat_link!.trim()} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="mr-1 h-3 w-3" /> Quick Chat
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}
