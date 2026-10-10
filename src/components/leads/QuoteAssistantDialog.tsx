import { useEffect, useState } from "react";
import { Loader2, Sparkles, Calculator, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  fetchQuoteEstimate,
  formatUsd,
  type QuoteAssistantResult,
} from "@/lib/ai/quote-assistant";

const CONFIDENCE_CLASS: Record<string, string> = {
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

/**
 * AI Quote Assistant (roadmap feature 05). Drafts an estimate range from
 * comparable past paid jobs. Advisory — a starting point for a human to quote.
 */
export default function QuoteAssistantDialog({ open, onOpenChange, leadId }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<QuoteAssistantResult | null>(null);

  useEffect(() => {
    if (!open || !leadId) return;
    let active = true;
    setLoading(true);
    setError("");
    setResult(null);
    (async () => {
      try {
        const res = await fetchQuoteEstimate(leadId);
        if (active) setResult(res);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not draft an estimate.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, leadId]);

  const estimate = result?.estimate ?? null;
  const comps = result?.comparables;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Calculator className="h-4 w-4 text-primary" />
            Draft estimate
          </DialogTitle>
          <DialogDescription className="text-xs">
            A starting range from comparable past paid jobs. Review before quoting — this is
            advisory, not a final price.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Comparing past paid jobs…
          </div>
        ) : error ? (
          <div className="flex h-40 items-center justify-center px-4 text-center text-sm text-rose-600 dark:text-rose-400">
            {error}
          </div>
        ) : estimate ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-4 text-center">
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {formatUsd(estimate.low)} – {formatUsd(estimate.high)}
              </div>
              <Badge
                variant="outline"
                className={`mt-2 text-[10px] font-semibold ${CONFIDENCE_CLASS[estimate.confidence]}`}
              >
                {estimate.confidence} confidence
              </Badge>
            </div>

            <p className="text-xs leading-relaxed text-foreground">
              <Sparkles className="mr-1 inline h-3 w-3 text-primary" />
              {estimate.rationale}
            </p>
            {estimate.caveats && (
              <p className="flex items-start gap-1.5 rounded-lg bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{estimate.caveats}</span>
              </p>
            )}

            {comps && comps.count > 0 && (
              <div className="border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                Based on <strong className="text-foreground">{comps.count}</strong> comparable paid
                {comps.scope === "same_area" ? " jobs in this area" : " jobs"} · median{" "}
                <strong className="text-foreground">{formatUsd(comps.median)}</strong> (range{" "}
                {formatUsd(comps.min)}–{formatUsd(comps.max)})
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <Calculator className="h-7 w-7 opacity-40" />
            {result?.message || "No estimate could be drafted for this lead."}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
