import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Sparkles, MessageSquareText, UserX, Star } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import QuoPhoneTrigger from "@/components/leads/QuoPhoneTrigger";
import type { TechnicianRecord } from "@/components/technicians/TechnicianDialog";
import { requestTechnicianChange } from "@/lib/tech-change-requests";
import { logActivity } from "@/lib/activity";

const LABELS = [
  ["tech_dont_respond", "Tech don't respond"],
  ["tech_is_scammer", "Tech is scammer"],
  ["late_payment", "Late payment"],
  ["never_responded", "Never responded to us"],
  ["high_rates", "High rates"],
  ["dont_cooperate", "Doesn't cooperate with us"],
  ["rude", "Rude"],
  ["paid_us_before", "Paid us before"],
  ["good_tech", "Good Tech"],
] as const;
type Label = (typeof LABELS)[number][0];
type Assessment = {
  technician_id: string;
  labels: Label[];
  ai_summary: string | null;
  ai_evidence: Array<{ label?: string; quote?: string }>;
  ai_recommendations: string[];
  conversations_reviewed: number;
  messages_reviewed: number;
  last_assessed_at: string | null;
};
type Report = { technicianId: string; jobsCompleted: number; jobsPaid: number; countBasis: string };
type AiResult = {
  technicianId: string;
  labels: Label[];
  recommendations: string[];
  summary: string;
  evidence: Array<{ label?: string; quote?: string }>;
  conversationsReviewed: number;
  messagesReviewed: number;
  jobCounts: { completed: number; paid: number };
  error: string | null;
};

const MESSAGE_TEMPLATE = "Hi {name}, just checking in—do you have availability for any upcoming jobs? Please let us know what types of work you can take and your current rates. Thanks!";

export function TechnicianProcessingWorkflow({
  technicians,
  initialTechnicianIds = [],
}: {
  technicians: TechnicianRecord[];
  initialTechnicianIds?: string[];
}) {
  const { role, user, canAccess } = useAuth();
  const canComposeTechMessage = role === "admin" || canAccess("tech_quick_chat");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(initialTechnicianIds.slice(0, 8));
  const [assessments, setAssessments] = useState<Record<string, Assessment>>({});
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [aiResults, setAiResults] = useState<Record<string, AiResult>>({});
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [proposedLabels, setProposedLabels] = useState<Record<string, Label[]>>({});
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (initialTechnicianIds.length) setSelectedIds(initialTechnicianIds.slice(0, 8));
  }, [initialTechnicianIds]); // route-driven selection from Map View

  const selectedTechnicians = useMemo(
    () => selectedIds.map((id) => technicians.find((tech) => tech.id === id)).filter((tech): tech is TechnicianRecord => Boolean(tech)),
    [selectedIds, technicians],
  );
  const visibleTechnicians = useMemo(() => {
    const query = search.trim().toLowerCase();
    return technicians
      .filter((tech) => !query || [tech.name, tech.phone_number, tech.area, tech.service].some((value) => value?.toLowerCase().includes(query)))
      // Unnamed import rows have no name and often no area, which renders as a
      // bare separator. Surface them by phone so they stay identifiable.
      .sort((left, right) => {
        const leftNamed = left.name?.trim() ? 0 : 1;
        const rightNamed = right.name?.trim() ? 0 : 1;
        if (leftNamed !== rightNamed) return leftNamed - rightNamed;
        return (left.name ?? "").localeCompare(right.name ?? "");
      })
      .slice(0, 100);
  }, [search, technicians]);

  useEffect(() => {
    if (!selectedIds.length) {
      setAssessments({});
      setReports({});
      return;
    }
    let active = true;
    void supabase.functions.invoke("technician-chat-assessment", { body: { action: "load", technicianIds: selectedIds } })
      .then(({ data, error }) => {
        if (error) throw error;
        if (!active) return;
        const nextAssessments: Record<string, Assessment> = {};
        for (const row of (data?.assessments ?? []) as Assessment[]) nextAssessments[row.technician_id] = row;
        const nextReports: Record<string, Report> = {};
        for (const report of (data?.reports ?? []) as Report[]) nextReports[report.technicianId] = report;
        setAssessments(nextAssessments);
        setReports(nextReports);
      })
      .catch((error) => {
        if (active) toast.error(error instanceof Error ? error.message : "Couldn't load technician reports.");
      });
    return () => { active = false; };
  }, [selectedIds]);

  const toggleTech = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((selectedId) => selectedId !== id);
      if (current.length >= 8) {
        toast.error("Assess up to 8 technicians at a time.");
        return current;
      }
      return [...current, id];
    });
  };

  const runAssessment = async () => {
    if (!selectedIds.length) return;
    setBusy(true);
    setAiResults({});
    const toastId = toast.loading(`Reviewing Quo conversations for ${selectedIds.length} technician${selectedIds.length === 1 ? "" : "s"}… This may take up to 3 minutes.`);
    try {
      const { data, error } = await supabase.functions.invoke("technician-chat-assessment", { body: { action: "assess", technicianIds: selectedIds } });
      if (error) throw error;
      const results = (data?.results ?? []) as AiResult[];
      const indexed = Object.fromEntries(results.map((result) => [result.technicianId, result]));
      setAiResults(indexed);
      setProposedLabels((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.technicianId, result.labels])) }));
      setReports((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.technicianId, {
          technicianId: result.technicianId,
          jobsCompleted: result.jobCounts.completed,
          jobsPaid: result.jobCounts.paid,
          countBasis: "Exact technician-name match; completed includes job_done and paid. Duplicate technician names may share historical counts.",
        }])),
      }));
      if (user?.id) {
        await Promise.all(results.filter((result) => !result.error).map((result) =>
          logActivity(user.id, "technician_chat_assessed", "technician", result.technicianId, {
            conversations_reviewed: result.conversationsReviewed,
            messages_reviewed: result.messagesReviewed,
            suggested_labels: result.labels,
          }).catch((auditError) => console.warn("Technician assessment succeeded, but audit logging failed", auditError)),
        ));
      }
      const failures = results.filter((result) => result.error);
      toast[failures.length ? "warning" : "success"](
        failures.length ? `${results.length - failures.length} assessments completed; ${failures.length} need retry.` : "Technician conversation review complete.",
        { id: toastId },
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Technician assessment failed.", { id: toastId });
    } finally {
      setBusy(false);
    }
  };

  const saveLabels = async (techId: string) => {
    setSavingId(techId);
    try {
      const { error } = await supabase.functions.invoke("technician-chat-assessment", {
        body: { action: "save_labels", technicianId: techId, labels: proposedLabels[techId] ?? [] },
      });
      if (error) throw error;
      const labels = proposedLabels[techId] ?? [];
      setAssessments((current) => ({ ...current, [techId]: { ...current[techId], technician_id: techId, labels } as Assessment }));
      if (user?.id) {
        await logActivity(user.id, "technician_workflow_labels_updated", "technician", techId, { labels })
          .catch((auditError) => console.warn("Technician labels saved, but audit logging failed", auditError));
      }
      toast.success("Technician labels saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save labels.");
    } finally {
      setSavingId(null);
    }
  };

  const requestFlag = async (tech: TechnicianRecord, changeType: "set_active" | "set_good_tech", value: boolean) => {
    setActionBusyId(tech.id);
    try {
      if (role === "admin") {
        const column = changeType === "set_active" ? "is_active" : "is_good_tech";
        const { error } = await supabase.from("technicians").update({ [column]: value } as never).eq("id", tech.id);
        if (error) throw error;
        if (user?.id) {
          await logActivity(user.id, "updated", "technician", tech.id, { [column]: value, source: "processing_workflow" })
            .catch((auditError) => console.warn("Technician updated, but audit logging failed", auditError));
        }
      } else {
        if (!user?.id) throw new Error("Sign in again to request this change.");
        await requestTechnicianChange({
          technicianId: tech.id,
          technicianName: tech.name,
          changeType,
          requestedValue: value,
          reason: "Suggested by Technician Processing Workflow; please review the conversation assessment.",
          requesterId: user.id,
        });
      }
      toast.success(role === "admin" ? "Technician record updated." : "Change sent to Admin for approval.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit technician change.");
    } finally {
      setActionBusyId(null);
    }
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Technician Processing Workflow</h2>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">Select up to 8 technicians. AI reviews up to the 250 most recent stored text messages per technician and suggests labels; it never marks a technician inactive or sends a message automatically. Reviews can take up to 3 minutes.</p>
          </div>
          <Button onClick={() => void runAssessment()} disabled={!selectedIds.length || busy} className="gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? "Reviewing conversations…" : `Quick Report (${selectedIds.length})`}
          </Button>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find technician by name, phone, area, or service" className="h-9" />
          <Button variant="outline" size="sm" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>Clear</Button>
        </div>
        <div className="mt-3 grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {visibleTechnicians.map((tech) => (
            <label key={tech.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted/60">
              <Checkbox checked={selectedIds.includes(tech.id)} onCheckedChange={() => toggleTech(tech.id)} />
              <span className="min-w-0 flex-1 truncate">
                {tech.name?.trim() || <span className="italic text-muted-foreground">Unnamed technician</span>}
                <span className="text-muted-foreground">{tech.area ? ` · ${tech.area}` : ""}</span>
              </span>
              {!tech.name?.trim() && <Badge variant="outline">No name</Badge>}
              {tech.is_active === false && <Badge variant="secondary">Inactive</Badge>}
            </label>
          ))}
        </div>
      </div>

      {selectedTechnicians.map((tech) => {
        const assessment = assessments[tech.id];
        const result = aiResults[tech.id];
        const report = reports[tech.id];
        const labels = proposedLabels[tech.id] ?? assessment?.labels ?? [];
        const recommendations = result?.recommendations ?? assessment?.ai_recommendations ?? [];
        const recommendsInactive = recommendations.includes("suggest_inactive");
        const recommendsMessage = recommendations.includes("suggest_check_job_message");
        const draft = MESSAGE_TEMPLATE.replace("{name}", tech.name?.trim().split(/\s+/)[0] || "there");
        return (
          <article key={tech.id} className="space-y-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{tech.name?.trim() || "Unnamed technician"}</h3>
                <p className="text-xs text-muted-foreground">{tech.service || "Service not set"} · {tech.area || "Area not set"} · {tech.phone_number || "No phone"}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">{report?.jobsCompleted ?? 0} jobs completed</Badge>
                <Badge variant="outline">{report?.jobsPaid ?? 0} jobs paid</Badge>
                {assessment?.last_assessed_at && <span className="text-muted-foreground">Reviewed {new Date(assessment.last_assessed_at).toLocaleString()}</span>}
              </div>
            </div>
            {report?.countBasis && <p className="text-[11px] text-muted-foreground">{report.countBasis}</p>}

            <div className="flex flex-wrap gap-2">
              {LABELS.map(([key, label]) => {
                const checked = labels.includes(key);
                return (
                  <button key={key} type="button" onClick={() => setProposedLabels((current) => ({ ...current, [tech.id]: checked ? labels.filter((item) => item !== key) : [...labels, key] }))} className={`rounded-full border px-2.5 py-1 text-xs ${checked ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                    {label}
                  </button>
                );
              })}
              <Button variant="outline" size="sm" className="h-7" disabled={savingId === tech.id} onClick={() => void saveLabels(tech.id)}>
                {savingId === tech.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}Save labels
              </Button>
            </div>

            {(result || assessment) && (
              <div className="space-y-2 rounded-lg bg-muted/30 p-3">
                <p className="text-sm">{result?.summary ?? assessment?.ai_summary}</p>
                <p className="text-[11px] text-muted-foreground">Reviewed {result?.conversationsReviewed ?? assessment?.conversations_reviewed ?? 0} conversations · {result?.messagesReviewed ?? assessment?.messages_reviewed ?? 0} messages{result?.error ? ` · Error: ${result.error}` : ""}</p>
                {(result?.evidence ?? assessment?.ai_evidence ?? []).map((item, index) => item.quote ? <blockquote key={index} className="border-l-2 border-primary/50 pl-2 text-xs italic text-muted-foreground">{item.quote}</blockquote> : null)}
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t pt-3">
              {(recommendsInactive || labels.some((label) => ["tech_dont_respond", "tech_is_scammer", "never_responded"].includes(label))) && tech.is_active !== false && (
                <Button variant="outline" size="sm" disabled={actionBusyId === tech.id} onClick={() => void requestFlag(tech, "set_active", false)}><UserX className="mr-1.5 h-3.5 w-3.5" />{role === "admin" ? "Mark inactive" : "Request inactive"}</Button>
              )}
              {canComposeTechMessage && (recommendsMessage || labels.includes("good_tech")) && tech.phone_number && (
                <QuoPhoneTrigger contactName={tech.name} phone={tech.phone_number} chatType="tech" initialMessage={draft}>
                  <Button variant="outline" size="sm"><MessageSquareText className="mr-1.5 h-3.5 w-3.5" />Compose job check-in</Button>
                </QuoPhoneTrigger>
              )}
              {labels.includes("good_tech") && !tech.is_good_tech && (
                <Button variant="outline" size="sm" disabled={actionBusyId === tech.id} onClick={() => void requestFlag(tech, "set_good_tech", true)}><Star className="mr-1.5 h-3.5 w-3.5" />{role === "admin" ? "Mark Good Tech" : "Request Good Tech"}</Button>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
