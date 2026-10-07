import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, Check } from "lucide-react";

interface Props {
  leadId: string;
  onApply: (reason: string, isAi: boolean, reasonCode: string) => void;
}

export default function CancellationReasonSuggest({ leadId, onApply }: Props) {
  const [loading, setLoading] = useState(true);
  const [suggestion, setSuggestion] = useState<{ reason_code: string; explanation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function fetchSuggestion() {
      try {
        const { data, error: fnError } = await supabase.functions.invoke("suggest-cancellation-reason", {
          body: { leadId }
        });

        if (fnError) throw fnError;
        if (!mounted) return;

        if (data?.suggestion) {
          setSuggestion(data.suggestion);
        } else {
          setError(data?.notice || "No suggestion available.");
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Failed to fetch suggestion");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchSuggestion();
    return () => { mounted = false; };
  }, [leadId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 p-3 rounded-md border border-border/50">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        AI is checking the conversation for a cancellation reason...
      </div>
    );
  }

  if (error || !suggestion) {
    return null;
  }

  const handleApply = () => {
    const text = `${suggestion.reason_code}: ${suggestion.explanation}`;
    onApply(text, true, suggestion.reason_code);
    setApplied(true);
  };

  return (
    <div className="flex flex-col gap-2 bg-muted/50 p-3 rounded-md border border-border/50 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <Sparkles className="h-4 w-4 text-purple-500 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium leading-none">
              AI Suggestion: {suggestion.reason_code}
            </p>
            <p className="text-sm text-muted-foreground">
              {suggestion.explanation}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleApply}
          disabled={applied}
          className="shrink-0"
        >
          {applied ? (
            <>
              <Check className="h-4 w-4 mr-1" />
              Applied
            </>
          ) : (
            "Apply reason"
          )}
        </Button>
      </div>
    </div>
  );
}
