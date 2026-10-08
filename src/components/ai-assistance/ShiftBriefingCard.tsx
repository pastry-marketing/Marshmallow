import { useState } from "react";
import { Sparkles, Loader2, RefreshCw, AlertTriangle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import {
  fetchShiftBriefing,
  canUseShiftBriefing,
  type ShiftBriefing,
  type BriefingPriority,
} from "@/lib/ai/shift-briefing";

const PRIORITY_CLASS: Record<BriefingPriority["priority"], string> = {
  high: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300",
  medium:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  low: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const PRIORITY_LABEL: Record<BriefingPriority["priority"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * Start-of-shift briefing (roadmap feature 03). A one-press summary of what's
 * outstanding — missed calls, unanswered texts, urgent leads, follow-ups —
 * turned into prioritised actions. Advisory; the counts shown are real.
 */
export default function ShiftBriefingCard() {
  const { role } = useAuth();
  const [loading, setLoading] = useState(false);
  const [briefing, setBriefing] = useState<ShiftBriefing | null>(null);

  if (!canUseShiftBriefing(role)) return null;

  const generate = async () => {
    setLoading(true);
    try {
      setBriefing(await fetchShiftBriefing(24));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate the briefing.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="glass-panel-strong rounded-2xl border border-border/60 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Shift briefing
          </div>
          <p className="text-xs text-muted-foreground sm:text-sm">
            A prioritised summary of missed calls, unanswered texts, urgent leads and open
            follow-ups from the last 24 hours.
          </p>
        </div>
        <Button
          size="sm"
          onClick={generate}
          disabled={loading}
          className="h-9 shrink-0 gap-2 text-xs self-start"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : briefing ? (
            <RefreshCw className="h-3.5 w-3.5" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {loading ? "Generating…" : briefing ? "Refresh briefing" : "Generate briefing"}
        </Button>
      </div>

      {briefing && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium text-foreground">{briefing.headline}</p>

          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Badge variant="outline" className="font-medium border-border/70">
              {briefing.stats.missedCalls} missed calls
            </Badge>
            <Badge variant="outline" className="font-medium border-border/70">
              {briefing.stats.unansweredTexts} unanswered texts
            </Badge>
            <Badge variant="outline" className="font-medium border-border/70">
              {briefing.stats.urgentLeads} urgent leads
            </Badge>
            <Badge variant="outline" className="font-medium border-border/70">
              {briefing.stats.followUps} follow-ups
            </Badge>
          </div>

          {briefing.priorities.length > 0 ? (
            <ol className="space-y-2">
              {briefing.priorities.map((p, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-background/50 p-2.5"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-foreground">{p.title}</span>
                      <Badge variant="outline" className={`text-[10px] font-semibold ${PRIORITY_CLASS[p.priority]}`}>
                        {PRIORITY_LABEL[p.priority]}
                      </Badge>
                    </div>
                    {p.detail && (
                      <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
                        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                        <span>{p.detail}</span>
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-emerald-500" />
              Nothing needs action right now.
            </p>
          )}

          <p className="text-[10px] text-muted-foreground">
            AI-generated from current CRM data · review before acting.
          </p>
        </div>
      )}
    </section>
  );
}
