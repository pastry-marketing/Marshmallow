import { useState } from "react";
import { Sparkles, Loader2, Send, MessageCircleQuestion } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { askCopilot, canUseCopilot, type CopilotAnswer } from "@/lib/ai/copilot";

const CONFIDENCE_CLASS: Record<string, string> = {
  high: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  medium:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  low: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const EXAMPLES = [
  "What was the last quote for …?",
  "How many paid garage door jobs?",
  "Any urgent leads in Texas?",
];

/**
 * In-App Copilot (roadmap feature 11). Answers staff questions about CRM
 * history from the leads they can see. Advisory and read-only.
 */
export default function CopilotCard() {
  const { role } = useAuth();
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CopilotAnswer | null>(null);
  const [asked, setAsked] = useState("");

  if (!canUseCopilot(role)) return null;

  const ask = async () => {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setAsked(q);
    setResult(null);
    try {
      setResult(await askCopilot(q));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The copilot could not answer.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="glass-panel-strong rounded-2xl border border-border/60 p-4 sm:p-5">
      <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
        <MessageCircleQuestion className="h-3.5 w-3.5" />
        Copilot
      </div>
      <p className="mb-3 text-xs text-muted-foreground sm:text-sm">
        Ask about CRM history — past quotes, jobs, customers, status. Answers come from the
        leads you can see.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about leads, quotes, or jobs…"
          className="h-9 text-xs bg-background/80"
          disabled={loading}
        />
        <Button type="submit" size="sm" disabled={loading || !question.trim()} className="h-9 shrink-0 gap-1.5 text-xs">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Ask
        </Button>
      </form>

      {!result && !loading && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setQuestion(ex)}
              className="rounded-full border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary/30 hover:text-foreground"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Looking it up…
        </div>
      )}

      {result && !loading && (
        <div className="mt-4 space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            <span className="text-foreground">Q:</span> {asked}
          </p>
          <div className="rounded-xl border border-primary/15 bg-primary/[0.04] p-3">
            <p className="flex items-start gap-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span>{result.answer}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Badge variant="outline" className={`font-semibold ${CONFIDENCE_CLASS[result.confidence]}`}>
              {result.confidence} confidence
            </Badge>
            {result.usedCount > 0 && (
              <span className="text-muted-foreground">
                from {result.usedCount} lead{result.usedCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {result.sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.sources.map((s, i) => (
                <span
                  key={i}
                  className="rounded-md border border-border/60 bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title={`${s.serviceType} · ${s.status}`}
                >
                  {s.jobId || s.customerName || "lead"}
                </span>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            AI answer from CRM data · verify before relying on it.
          </p>
        </div>
      )}
    </section>
  );
}
