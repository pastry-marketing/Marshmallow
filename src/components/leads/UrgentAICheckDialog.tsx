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
  submitUrgentReviewRequest,
  type UrgentCheckMode,
  type UrgentIssue,
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
  jobId?: string | null;
  customerName?: string | null;
  previousStatus?: string | null;
  onProceed: () => void;
  /**
   * Advisory for admin, processor and cs_admin: the comparison runs and the
   * findings are shown, but the person making the call decides. Enforced for
   * customer_service, where findings block and a CS Admin has to sign off.
   *
   * Defaults to enforced, so a caller that forgets to pass it gets the stricter
   * behaviour rather than the looser one.
   */
  mode?: UrgentCheckMode;
}

const SEVERITY_ORDER: Record<UrgentIssue["severity"], number> = { high: 0, medium: 1, low: 2 };

export default function UrgentAICheckDialog({
  open, onOpenChange, leadId, jobId, customerName, previousStatus, onProceed, mode = "enforced",
}: Props) {
  const advisory = mode === "advisory";
  const [result, setResult] = useState<UrgentVerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editLead, setEditLead] = useState(false);
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
      setEditLead(false);
    }
  }, [open]);

  async function run() {
    setBusy(true);
    setResult(null);
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

  async function sendForReview() {
    if (!result) return;
    setSubmitting(true);
    try {
      await submitUrgentReviewRequest({
        leadId,
        issues: result.issues,
        summary: result.summary,
        jobId,
        customerName,
        previousStatus,
      });
      toast.success("Sent to a CS Admin for review.");
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not send this for review.");
    } finally {
      setSubmitting(false);
    }
  }

  const issues = [...(result?.issues ?? [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const clean = result?.state === "checked" && issues.length === 0;
  const unavailable = result?.state === "unavailable" || result?.state === "error";

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
            {advisory ? "Worth a look before dispatch" : "Check before marking urgent"}
          </DialogTitle>
          <DialogDescription>
            {advisory
              ? "Comparing this record against what the customer actually agreed to. You can mark it urgent either way."
              : "Comparing this record against what the customer actually agreed to."}
          </DialogDescription>
        </DialogHeader>

        {busy && (
          <div className="py-10 text-center space-y-3">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Reading the conversation. This usually takes a couple of seconds.
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
            <div className="flex items-center justify-between rounded-lg border p-3">
              <p className="text-sm">Fix the record first, then check again.</p>
              <Button variant="outline" size="sm" onClick={() => setEditLead(true)}>
                {editLead ? "Close lead" : "Edit lead first"}
              </Button>
            </div>
          </div>
        )}

        {!busy && result && !clean && !unavailable && issues.length > 0 && (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">
                  {issues.length} thing{issues.length === 1 ? "" : "s"} to look at
                </p>
                {result.summary && <p className="text-sm text-amber-800 mt-1">{result.summary}</p>}
              </div>
            </div>

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

            <p className="text-xs text-muted-foreground">
              Compared {result.messageCount} message{result.messageCount === 1 ? "" : "s"}.{" "}
              {advisory
                ? "These are for you to weigh. Marking it urgent is your call."
                : "Fix what is wrong, or send it to a CS Admin. It will not become urgent either way without a decision."}
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {editLead && (
            <Button variant="ghost" onClick={() => { setEditLead(false); void run(); }} disabled={busy}>
              Check again
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {clean ? "Cancel" : "Leave as is"}
          </Button>

          {clean && (
            <Button onClick={() => applyUrgent(false)} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent"}
            </Button>
          )}

          {unavailable && !editLead && (
            <Button onClick={proceedUnchecked} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent unchecked"}
            </Button>
          )}

          {!clean && !unavailable && issues.length > 0 && (
            <>
              <Button variant="outline" onClick={() => { onOpenChange(false); setEditLead(true); }} disabled={submitting}>
                Fix it first
              </Button>
              {advisory ? (
                // Same RPC the clean path uses, so the status change and the queue
                // are settled in one transaction exactly as they are for a clean
                // result. Nothing here records a passed check.
                <Button onClick={() => applyUrgent(true)} disabled={submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark urgent anyway"}
                </Button>
              ) : (
                <Button onClick={sendForReview} disabled={submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send to CS Admin"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}