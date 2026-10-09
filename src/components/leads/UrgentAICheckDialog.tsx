import { useEffect, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, ShieldAlert } from "lucide-react";
import {
  runUrgentVerification,
  applyUrgentAcknowledgement,
  applyUrgentVerification,
  applyUrgentFormFixes,
  type UrgentFix,
  type UrgentVerificationResult,
} from "@/lib/urgent-verification";
import { toast } from "sonner";

// =============================================================================
// The one-time form check that runs before a lead becomes urgent.
//
// Reviews the latest confirmed customer scope/quote in all matched stored chat
// messages, and uses Google's verified address as the location baseline.
// For each suggested correction the user must either Apply it or
// Dismiss it; the lead cannot be marked urgent until every suggestion is
// resolved. Missing required details are shown as flags for staff to fill in.
//
//   clean          nothing to correct. Straight through.
//   suggestions    one or more fixes/flags. Resolve each fix, then proceed.
//   unavailable    the AI check could not run (outage/timeout). A deliberate
//                  acknowledgement lets the lead through so an outage never
//                  blocks dispatch permanently.
// =============================================================================

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  onProceed: () => void;
}

export default function UrgentAICheckDialog({
  open, onOpenChange, leadId, onProceed,
}: Props) {
  const [result, setResult] = useState<UrgentVerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [appliedFields, setAppliedFields] = useState<Set<string>>(new Set());
  const [dismissedFields, setDismissedFields] = useState<Set<string>>(new Set());
  const startedFor = useRef<string | null>(null);

  // Run once when the dialog opens for a lead, not on every render. A second run
  // is an explicit choice, made after an edit.
  useEffect(() => {
    if (!open || !leadId) return;
    if (startedFor.current === leadId) return;
    startedFor.current = leadId;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, leadId]);

  useEffect(() => {
    if (!open) {
      startedFor.current = null;
      setResult(null);
    }
  }, [open]);

  async function run() {
    setBusy(true);
    setResult(null);
    setAppliedFields(new Set());
    setDismissedFields(new Set());
    try {
      setResult(await runUrgentVerification(leadId));
    } catch (err: unknown) {
      setResult({
        state: "error",
        issues: [],
        fixes: [],
        flags: [],
        summary: "",
        notice: err instanceof Error ? err.message : "The check could not be run.",
        conversationFound: false,
        messageCount: 0,
        reason: "unknown",
        elapsedMs: 0,
      });
    } finally {
      setBusy(false);
    }
  }

  // The form check passed (or every suggestion was resolved). The database moves
  // the lead to urgent and stamps the activity log.
  async function markUrgent() {
    setSubmitting(true);
    const parts = [];
    if (appliedFields.size) parts.push(`${appliedFields.size} applied`);
    if (dismissedFields.size) parts.push(`${dismissedFields.size} dismissed`);
    const summary = parts.length
      ? `${result?.summary || "Latest agreement reviewed."} ${parts.join(", ")}.`
      : result?.summary || "Latest customer agreement checked — nothing to correct.";
    try {
      await applyUrgentVerification(leadId, summary);
      toast.success("Lead reviewed. Marked urgent.");
      onProceed();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not mark the lead urgent.");
    } finally {
      setSubmitting(false);
    }
  }

  // The AI check could not run. Recorded as an acknowledgement so it never reads
  // as a passed check, and so an outage does not block dispatch forever.
  async function proceedUnchecked() {
    setSubmitting(true);
    try {
      await applyUrgentAcknowledgement(leadId, result?.notice ?? "The form check could not be run.");
      toast.success("Marked urgent without a check. Recorded as an acknowledgement.");
      onProceed();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not mark the lead urgent.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApplyFix(fix: UrgentFix) {
    try {
      setSubmitting(true);
      // The RPC reads {field, old, new}; UrgentFix carries current/suggested.
      await applyUrgentFormFixes(leadId, [{ field: fix.field, old: fix.current, new: fix.suggested }]);
      setAppliedFields((prev) => new Set(prev).add(fix.field));
      toast.success(`Updated ${fix.field.replace(/_/g, " ")}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to apply fix");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDismissFix(field: string) {
    setDismissedFields((prev) => new Set(prev).add(field));
  }

  function handleUndoDismiss(field: string) {
    setDismissedFields((prev) => {
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }

  const fixes = result?.fixes ?? [];
  const flags = result?.flags ?? [];
  const checked = result?.state === "checked";
  const clean = checked && fixes.length === 0 && flags.length === 0;
  const unavailable = result?.state === "unavailable" || result?.state === "error";
  const hasItems = fixes.length > 0 || flags.length > 0;
  const isResolved = (field: string) => appliedFields.has(field) || dismissedFields.has(field);
  const unresolvedCount = fixes.filter((f) => !isResolved(f.field)).length;
  const allFixesResolved = unresolvedCount === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : clean ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : unavailable ? (
              <HelpCircle className="h-5 w-5 text-amber-600" />
            ) : (
              <ShieldAlert className="h-5 w-5 text-amber-600" />
            )}
            Review the latest agreement before dispatch
          </DialogTitle>
          <DialogDescription>
            Review the latest agreed job details, final quote, and Google-formatted address. Apply or dismiss each correction before marking urgent.
          </DialogDescription>
        </DialogHeader>

        {busy && (
          <div className="py-10 text-center space-y-3">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Reading the full stored customer conversation, checking the latest agreement, and looking up the service address. This may take up to a minute.
            </p>
          </div>
        )}

        {!busy && result?.state === "checked" && <div className="space-y-1 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground"><p className="font-medium text-foreground">Reviewed {result.messageCount} stored messages, oldest to newest</p>{result.notice && <p>{result.notice}</p>}</div>}

        {!busy && result && clean && (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 flex gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-emerald-900">No supported corrections found</p>
                <p className="text-sm text-emerald-800 mt-1">
                  {result.summary || "Nothing to correct. You can mark this lead urgent."}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Marking a lead urgent sets dispatch priority. It does not change the agreed schedule.
            </p>
          </div>
        )}

        {!busy && result && unavailable && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex gap-3">
              <HelpCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">The complete review could not run</p>
                <p className="text-sm text-amber-800 mt-1">{result.notice}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Marking this urgent will be recorded as an acknowledgement, not as a passed check.
            </p>
            {result.state === "error" && result.reason && result.reason !== "unknown" && (
              <p className="text-xs text-muted-foreground">
                Reason: <code className="bg-muted px-1.5 py-0.5 rounded">{result.reason}</code>
              </p>
            )}
          </div>
        )}

        {!busy && result && checked && hasItems && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">
                  {fixes.length > 0
                    ? "Fix these before marking urgent"
                    : "Please check the missing details"}
                </p>
                <p className="text-sm text-amber-800 mt-1">
                  {fixes.length > 0
                    ? "Apply or dismiss each suggestion below — the lead can go urgent once all are resolved."
                    : (result.summary || "Some required details are missing.")}
                </p>
              </div>
            </div>

            {fixes.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground/80">
                  Suggested Corrections{unresolvedCount > 0 ? ` (${unresolvedCount} left)` : ""}
                </h3>
                {fixes.map((fix, index) => {
                  const isApplied = appliedFields.has(fix.field);
                  const isDismissed = dismissedFields.has(fix.field);
                  return (
                    <div
                      key={`fix-${index}`}
                      className={`flex items-center justify-between rounded-lg border p-3 bg-card shadow-sm ${isApplied || isDismissed ? "opacity-70" : ""}`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium uppercase tracking-wide text-muted-foreground">{fix.field.replace(/_/g, " ")}</span>
                          {fix.kind && <span className="bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded uppercase">{fix.kind}</span>}
                        </div>
                        <p className="text-sm">
                          <span className="text-muted-foreground line-through mr-2">{fix.current || "(empty)"}</span>
                          <span className="whitespace-pre-wrap font-medium text-emerald-600 dark:text-emerald-400">→ {fix.suggested}</span>
                        </p>
                        {fix.reason && <p className="text-xs text-muted-foreground">{fix.reason}</p>}
                        {fix.evidence?.map((item, evidenceIndex) => <blockquote key={evidenceIndex} className="border-l-2 border-primary/30 pl-2 text-xs text-muted-foreground">“{item.quote}”</blockquote>)}
                      </div>
                      {isApplied ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 shrink-0">
                          <CheckCircle2 className="h-4 w-4" /> Applied
                        </span>
                      ) : isDismissed ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground">Dismissed</span>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => handleUndoDismiss(fix.field)} disabled={submitting}>
                            Undo
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 shrink-0">
                          <Button size="sm" onClick={() => handleApplyFix(fix)} disabled={submitting}>
                            Apply
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => handleDismissFix(fix.field)} disabled={submitting}>
                            Dismiss
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {flags.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground/80">Missing Information</h3>
                {flags.map((flag, index) => (
                  <div key={`flag-${index}`} className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-rose-500" />
                      <span className="text-xs font-medium uppercase tracking-wide text-rose-600">{flag.field.replace(/_/g, " ")}</span>
                    </div>
                    <p className="text-sm text-rose-900">{flag.message}</p>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Missing details can’t be auto-filled — close this to edit the lead, or continue if they’re not needed.
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {clean ? "Cancel" : "Keep current status"}
          </Button>

          {clean && (
            <Button onClick={markUrgent} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent"}
            </Button>
          )}

          {unavailable && (
            <Button onClick={proceedUnchecked} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent (check unavailable)"}
            </Button>
          )}

          {checked && hasItems && (
            <Button
              onClick={markUrgent}
              disabled={submitting || !allFixesResolved}
              title={!allFixesResolved ? "Apply or dismiss each suggestion first" : undefined}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : allFixesResolved ? (
                "Mark urgent"
              ) : (
                `Resolve ${unresolvedCount} to continue`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
