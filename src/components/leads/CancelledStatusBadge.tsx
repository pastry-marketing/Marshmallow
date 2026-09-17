import { useCallback, useState } from "react";
import { format } from "date-fns";
import { Info, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fetchLatestCancellationRequest } from "@/lib/cancellation-requests";
import StatusBadge from "./StatusBadge";
import type { LeadCancellationRequest, LeadStatus } from "@/types";

/** What to reveal on hover over a Paid badge: a heading and a display value. */
export interface PaidAmountInfo {
  heading: string;
  value: string;
}

interface Props {
  leadId: string;
  status: LeadStatus;
  size?: "sm" | "md";
  /** Amount details shown on hover over a Paid badge. Pass null to hide it. */
  paidInfo?: PaidAmountInfo | null;
}

function formatWhen(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : format(date, "MMM d, yyyy 'at' h:mm a");
}

/**
 * Paid badge that reveals the payment amount on hover (and tap on touch),
 * so the number is one glance away without opening the lead.
 */
function PaidAmountBadge({ status, size, info }: { status: LeadStatus; size: "sm" | "md"; info: PaidAmountInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          aria-label={`${info.heading}: ${info.value}`}
          className="inline-flex items-center rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <StatusBadge status={status} size={size} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-auto max-w-[240px] px-3 py-2"
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={() => setOpen(false)}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{info.heading}</p>
        <p className="whitespace-pre-wrap break-words text-base font-bold leading-tight text-[hsl(var(--status-green))]">{info.value}</p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The cancellation reason is written on the request row and never copied onto the lead, so a
 * cancelled lead showed no reason at all. This keeps the badge exactly as it was and hangs the
 * reason off it: one quiet info dot, and the request is only read when someone opens it — which
 * also means leads cancelled long before this existed show their reason too.
 */
export default function CancelledStatusBadge({ leadId, status, size = "sm", paidInfo }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [request, setRequest] = useState<LeadCancellationRequest | null>(null);

  const isCancelled = status === "cancelled";
  const isPaid = status === "paid";

  const handleOpenChange = useCallback(
    async (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen || loaded || loading) return;

      setLoading(true);
      try {
        setRequest(await fetchLatestCancellationRequest(leadId));
        setLoaded(true);
      } finally {
        setLoading(false);
      }
    },
    [leadId, loaded, loading],
  );

  if (isPaid && paidInfo) return <PaidAmountBadge status={status} size={size} info={paidInfo} />;

  if (!isCancelled) return <StatusBadge status={status} size={size} />;

  const requestedAt = formatWhen(request?.created_at ?? null);
  const reviewedAt = formatWhen(request?.reviewed_at ?? null);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          // Opens on hover as well as click, so the full detail needs no aiming on desktop
          // while touch devices still have the tap.
          onMouseEnter={() => void handleOpenChange(true)}
          onFocus={() => void handleOpenChange(true)}
          aria-label="Show cancellation reason"
          className="inline-flex items-center gap-1 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <StatusBadge status={status} size={size} />
          <Info className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-72 p-0 text-left"
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={() => setOpen(false)}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b border-border/40 px-3 py-2">
          <p className="text-[12px] font-semibold text-foreground">Cancellation reason</p>
        </div>

        <div className="max-h-64 space-y-2.5 overflow-y-auto px-3 py-2.5">
          {loading && (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading...
            </p>
          )}

          {!loading && !request && (
            <p className="text-[12px] leading-5 text-muted-foreground">
              No reason was recorded. This lead was cancelled directly rather than through a
              cancellation request.
            </p>
          )}

          {!loading && request && (
            <>
              <p className="whitespace-pre-wrap text-[12.5px] leading-5 text-foreground">
                {request.comment}
              </p>

              {request.proof && (
                <p className="text-[11px] leading-4 text-muted-foreground">
                  <span className="font-medium text-foreground/80">Proof: </span>
                  {request.proof}
                </p>
              )}

              <div className="space-y-0.5 border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
                <p>
                  Requested by {request.requester_name || request.requested_by_name || "Unknown"}
                  {requestedAt ? ` - ${requestedAt}` : ""}
                </p>
                {request.status === "approved" && (
                  <p>
                    Approved by {request.reviewer_name || request.reviewed_by_name || "Unknown"}
                    {reviewedAt ? ` - ${reviewedAt}` : ""}
                  </p>
                )}
                {request.status === "rejected" && <p>This request was rejected.</p>}
                {request.status === "pending" && <p>This request is still pending.</p>}
                {request.review_note && (
                  <p className="pt-1 text-foreground/80">Note: {request.review_note}</p>
                )}
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
