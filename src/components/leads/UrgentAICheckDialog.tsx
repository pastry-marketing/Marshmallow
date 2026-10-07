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
  type UrgentIssue,
  type UrgentFix,
  type UrgentFlag,
  type UrgentVerificationResult,
} from "@/lib/urgent-verification";
import { toast } from "sonner";

// =============================================================================
// The one-time check that runs before a lead becomes urgent.
//
// Three shapes, and the copy is written so nobody mistakes one for another:
//
//   clean          nothing disagrees. Straight through, no second click, because
//                  a gate that makes people confirm good news gets disabled.
//
//   issues         something disagrees. Each one carries the customer's own words
//                  so it can be checked in two seconds, and the lead goes to a
//                  CS Admin rather than anywhere near urgent.
//
//   unavailable    nothing could be compared. This is not a finding and not a
//                  pass. It needs a deliberate yes, because proceeding here is
//                  proceeding unchecked.
//
// The check runs once per attempt. Re-running is allowed only after changing
// something worth re-checking, which is the point of letting the CS member edit
// first.
// =============================================================================

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  onProceed: () => void;
}

const SEVERITY_ORDER: Record<UrgentIssue["severity"], number> = { high: 0, medium: 1, low: 2 };

export default function UrgentAICheckDialog({
  open, onOpenChange, leadId, onProceed,
}: Props) {
  const [result, setResult] = useState<UrgentVerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [appliedFields, setAppliedFields] = useState<Set<string>>(new Set());
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
    try {
      setResult(await runUrgentVerification(leadId));
    } catch (err: unknown) {
      setResult({
        state: "error",
        issues: [],
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

  // One path for both "it came back clean" and "I have read the findings and I am
  // proceeding anyway". They differ only in what gets written down.
  //
  // The summary is passed explicitly in both cases. approve_urgent_verification
  // falls back to 'All verification checks passed' when it is given nothing, so
  // proceeding over findings without a summary would put a clean check into the
  // activity log for a check that found problems.
  async function applyUrgent(overridden: boolean) {
    setSubmitting(true);
    const summary = overridden
      ? `Proceeded over ${issues.length} finding${issues.length === 1 ? "" : "s"}: ${
          result?.summary || "reviewed and accepted"
        }`
      : result?.summary || "";
    try {
      await applyUrgentVerification(leadId, summary);
      toast.success(
        overridden
          ? "Marked urgent. The findings were recorded as reviewed."
          : "Checked against the conversation. Marked urgent.",
      );
      onProceed();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not mark the lead urgent.");
    } finally {
      setSubmitting(false);
    }
  }

  async function proceedUnchecked() {
    setSubmitting(true);
    try {
      await applyUrgentAcknowledgement(leadId, result?.notice ?? "No conversation available to check");
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
      await applyUrgentFormFixes(leadId, [fix]);
      setAppliedFields((prev) => new Set(prev).add(fix.field));
      toast.success(`Updated ${fix.field.replace(/_/g, " ")}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to apply fix");
    } finally {
      setSubmitting(false);
    }
  }


  const issues = [...(result?.issues ?? [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const fixes = result?.fixes ?? [];
  const flags = result?.flags ?? [];
  const clean = result?.state === "checked" && issues.length === 0 && fixes.length === 0 && flags.length === 0;
  const unavailable = result?.state === "unavailable" || result?.state === "error";
  const hasActionableItems = issues.length > 0 || fixes.length > 0 || flags.length > 0;

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
            Worth a look before dispatch
          </DialogTitle>
          <DialogDescription>
            Comparing the job details with the customer’s conversation. Review any suggestions, then choose whether to update the record or continue to Urgent.
          </DialogDescription>
        </DialogHeader>

        {busy && (
          <div className="py-10 text-center space-y-3">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Reviewing the conversation and job details. This usually takes about 5–6 seconds.
            </p>
          </div>
        )}

        {!busy && result && clean && (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 flex gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-emerald-900">Nothing contradicts the conversation</p>
                {result.summary && <p className="text-sm text-emerald-800 mt-1">{result.summary}</p>}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Compared {result.messageCount} message{result.messageCount === 1 ? "" : "s"} in{" "}
              {(result.elapsedMs / 1000).toFixed(1)}s. The agreed schedule is not changed by marking a lead urgent.
            </p>
          </div>
        )}

        {!busy && result && unavailable && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex gap-3">
              <HelpCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">This could not be checked</p>
                <p className="text-sm text-amber-800 mt-1">{result.notice}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Nothing was found wrong, because nothing was compared. Marking this urgent will be recorded
              as an acknowledgement, not as a passed check.
            </p>
            {result.state === "error" && result.reason && result.reason !== "unknown" && (
              <p className="text-xs text-muted-foreground">
                Reason: <code className="bg-muted px-1.5 py-0.5 rounded">{result.reason}</code>
              </p>
            )}
          </div>
        )}

        {!busy && result && !clean && !unavailable && hasActionableItems && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">
                  Things to look at
                </p>
                {result.summary && <p className="text-sm text-amber-800 mt-1">{result.summary}</p>}
              </div>
            </div>

            {fixes.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground/80">Suggested Corrections</h3>
                {fixes.map((fix, index) => {
                  const isApplied = appliedFields.has(fix.field);
                  return (
                    <div key={`fix-${index}`} className="flex items-center justify-between rounded-lg border p-3 bg-card shadow-sm">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium uppercase tracking-wide text-muted-foreground">{fix.field.replace(/_/g, " ")}</span>
                          <span className="bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded uppercase">{fix.kind}</span>
                        </div>
                        <p className="text-sm">
                          <span className="text-muted-foreground line-through mr-2">{fix.current || "(empty)"}</span>
                          <span className="font-medium text-emerald-600 dark:text-emerald-400">→ {fix.suggested}</span>
                        </p>
                        {fix.reason && <p className="text-xs text-muted-foreground">{fix.reason}</p>}
                      </div>
                      <Button
                        size="sm"
                        variant={isApplied ? "outline" : "default"}
                        disabled={isApplied || submitting}
                        onClick={() => handleApplyFix(fix)}
                      >
                        {isApplied ? "Applied" : "Apply"}
                      </Button>
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
              </div>
            )}

            {issues.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground/80">Potential Discrepancies</h3>
                {issues.map((issue, index) => (
                  <div key={`${issue.check}-${index}`} className="rounded-lg border p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {issue.check.replace(/_/g, " ")}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          issue.severity === "high"
                            ? "bg-red-100 text-red-800"
                            : issue.severity === "medium"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {issue.severity}
                      </span>
                      {issue.field && (
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{issue.field}</code>
                      )}
                    </div>
                    <p className="text-sm font-medium">{issue.problem}</p>
                    {issue.evidence && (
                      <blockquote className="text-sm text-muted-foreground border-l-2 pl-3 italic">
                        “{issue.evidence}”
                      </blockquote>
                    )}
                    {issue.suggestion && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">Suggested fix: </span>
                        {issue.suggestion}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Compared {result.messageCount} message{result.messageCount === 1 ? "" : "s"}.{" "}
              Suggestions are advisory. You can close this review to update the job, or continue to Urgent without making changes.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {clean ? "Cancel" : "Keep current status"}
          </Button>

          {clean && (
            <Button onClick={() => applyUrgent(false)} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent"}
            </Button>
          )}

          {unavailable && (
            <Button onClick={proceedUnchecked} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent unchecked"}
            </Button>
          )}

          {!clean && !unavailable && hasActionableItems && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Review job details
              </Button>
              {/* Same RPC the clean path uses, so the status change and any open
                  request settle in one transaction exactly as they do for a clean
                  result. The explicit summary on the override path is what stops
                  this writing "all checks passed" for a check that found
                  problems. */}
              <Button onClick={() => applyUrgent(true)} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent anyway"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
