import { useEffect, useState } from "react";
import { Loader2, Gauge, TrendingUp, DollarSign } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  fetchLeadScore,
  TIER_CLASS,
  TIER_LABEL,
  type LeadScore,
  type ScoreLevel,
} from "@/lib/ai/lead-scoring";

const LEVEL_LABEL: Record<ScoreLevel, string> = { low: "Low", medium: "Medium", high: "High" };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
}

/**
 * AI Lead Scoring (roadmap feature 07). Shows a follow-up priority score with
 * the factors behind it. Advisory — a signal to order follow-ups.
 */
export default function LeadScoreDialog({ open, onOpenChange, leadId }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [score, setScore] = useState<LeadScore | null>(null);

  useEffect(() => {
    if (!open || !leadId) return;
    let active = true;
    setLoading(true);
    setError("");
    setScore(null);
    (async () => {
      try {
        const res = await fetchLeadScore(leadId);
        if (active) setScore(res);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not score this lead.");
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
            <Gauge className="h-4 w-4 text-primary" />
            Lead priority score
          </DialogTitle>
          <DialogDescription className="text-xs">
            A follow-up priority from likely conversion and potential value. Advisory — it changes
            no status and sets no field.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Scoring…
          </div>
        ) : error ? (
          <div className="flex h-40 items-center justify-center px-4 text-center text-sm text-rose-600 dark:text-rose-400">
            {error}
          </div>
        ) : score ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-background/50 p-4">
              <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
                <span className="text-3xl font-bold tracking-tight text-foreground">{score.score}</span>
              </div>
              <div className="min-w-0 flex-1">
                <Badge variant="outline" className={`text-xs font-semibold ${TIER_CLASS[score.tier]}`}>
                  {TIER_LABEL[score.tier]}
                </Badge>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-muted-foreground">
                    <TrendingUp className="h-3 w-3" /> Conversion: {LEVEL_LABEL[score.conversion]}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-muted-foreground">
                    <DollarSign className="h-3 w-3" /> Value: {LEVEL_LABEL[score.value]}
                  </span>
                </div>
              </div>
            </div>

            {score.summary && <p className="text-xs font-medium text-foreground">{score.summary}</p>}

            {score.reasons.length > 0 && (
              <ul className="space-y-1 pl-4 list-disc text-[11px] text-muted-foreground">
                {score.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}

            <p className="border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
              {score.conversationFound ? "Scored from the lead and its chat." : "Scored from the lead record only (no linked chat)."}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
