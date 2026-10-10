import { useEffect, useState } from "react";
import { Loader2, CalendarClock, AlertTriangle, Clock, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  fetchScheduleParse,
  type ScheduleAssistantResult,
  type ScheduleConfidence,
} from "@/lib/ai/schedule-assistant";

const CONFIDENCE_CLASS: Record<ScheduleConfidence, string> = {
  high: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  medium:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  low: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
}

function timeRange(start: string, end: string, allDay: boolean): string {
  if (allDay) return "All day";
  if (start && end) return `${start}–${end}`;
  if (start) return `from ${start}`;
  return "time not specified";
}

/**
 * AI Schedule Assistant (roadmap feature 06). Parses the lead's scheduling
 * request into windows and warns about overdue work or technician clashes.
 * Advisory — it normalises and warns; the person books.
 */
export default function ScheduleAssistantDialog({ open, onOpenChange, leadId }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScheduleAssistantResult | null>(null);

  useEffect(() => {
    if (!open || !leadId) return;
    let active = true;
    setLoading(true);
    setError("");
    setResult(null);
    (async () => {
      try {
        const res = await fetchScheduleParse({ leadId });
        if (active) setResult(res);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not parse the schedule.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, leadId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-primary" />
            Schedule assistant
          </DialogTitle>
          <DialogDescription className="text-xs">
            Reads this lead's schedule requirement, resolves it to date/time windows (Eastern),
            and flags overdue work or technician clashes. Advisory — confirm before booking.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Reading the schedule request…
          </div>
        ) : error ? (
          <div className="flex h-36 items-center justify-center px-4 text-center text-sm text-rose-600 dark:text-rose-400">
            {error}
          </div>
        ) : result ? (
          <div className="space-y-3">
            {result.overdue && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>Overdue:</strong> scheduled for {result.overdue.scheduledDate}, which is in
                  the past and the job is not finished.
                </span>
              </div>
            )}

            {result.conflicts.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
                <div className="mb-1 flex items-center gap-1.5 font-semibold">
                  <Users className="h-3.5 w-3.5" />
                  Possible clash — same technician already booked
                </div>
                <ul className="space-y-0.5 pl-5 list-disc">
                  {result.conflicts.map((c, i) => (
                    <li key={i}>
                      {c.customerName} on {c.date}
                      {c.startTime ? ` (${c.startTime}${c.endTime ? `–${c.endTime}` : ""})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.windows.length > 0 ? (
              <div className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Parsed windows</span>
                {result.windows.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg border border-border/60 bg-background/50 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{w.label || w.date}</div>
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {w.date} · {timeRange(w.startTime, w.endTime, w.allDay)}
                      </div>
                    </div>
                    <Badge variant="outline" className={`text-[10px] font-semibold ${CONFIDENCE_CLASS[w.confidence]}`}>
                      {w.confidence}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No schedulable date/time found in this lead's requirement.
              </p>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
