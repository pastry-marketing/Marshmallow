import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Search,
  Sparkles,
  MessageSquareText,
  UserX,
  Star,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import QuoPhoneTrigger from "@/components/leads/QuoPhoneTrigger";
import type { TechnicianRecord } from "@/components/technicians/TechnicianDialog";
import { TechnicianNameBadges } from "@/components/technicians/TechnicianNameCell";
import { buildTechnicianNameCounts } from "@/lib/technician-names";
import { buildPickerPages } from "@/lib/picker-pages";
import { requestTechnicianChange } from "@/lib/tech-change-requests";
import { logActivity } from "@/lib/activity";
import { TECHNICIANS_ROOT_KEY } from "@/lib/technicians";

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
type Evidence = { label?: string; quote?: string; source?: string };
type Assessment = {
  technician_id: string;
  labels: Label[];
  ai_summary: string | null;
  ai_evidence: Evidence[];
  ai_recommendations: string[];
  conversations_reviewed: number;
  messages_reviewed: number;
  last_assessed_at: string | null;
};
type Report = { technicianId: string; jobsCompleted: number | null; jobsPaid: number | null; countBasis: string; error?: string | null };
type AiResult = {
  technicianId: string;
  labels: Label[];
  recommendations: string[];
  summary: string;
  evidence: Evidence[];
  conversationsReviewed: number;
  messagesReviewed: number;
  jobCounts: { completed: number | null; paid: number | null; error: string | null };
  error: string | null;
};

const MESSAGE_TEMPLATE = "Hi {name}, just checking in—do you have availability for any upcoming jobs? Please let us know what types of work you can take and your current rates. Thanks!";

// The picker is paginated rather than capped: an earlier cap meant only the
// first 100 names in the alphabet were ever reachable.
const PICKER_PAGE_SIZES = [25, 50, 100, 200] as const;
const PICKER_PAGE_SIZE_KEY = "marshmallow.technicians.workflowPageSize";

function loadPickerPageSize(): number {
  try {
    const raw = localStorage.getItem(PICKER_PAGE_SIZE_KEY);
    const parsed = Number(raw);
    if (PICKER_PAGE_SIZES.includes(parsed as (typeof PICKER_PAGE_SIZES)[number])) return parsed;
  } catch {
    // ignore storage errors
  }
  return 50;
}

export function TechnicianProcessingWorkflow({
  technicians,
  initialTechnicianIds = [],
}: {
  technicians: TechnicianRecord[];
  initialTechnicianIds?: string[];
}) {
  const { role, user, canAccess } = useAuth();
  const queryClient = useQueryClient();
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
  const [flagActions, setFlagActions] = useState<Record<string, "applied" | "requested">>({});
  const [pickerPage, setPickerPage] = useState(1);
  const [pickerPageSize, setPickerPageSizeState] = useState(loadPickerPageSize);
  const setPickerPageSize = (next: number) => {
    setPickerPageSizeState(next);
    try {
      localStorage.setItem(PICKER_PAGE_SIZE_KEY, String(next));
    } catch {
      // ignore storage errors
    }
  };

  useEffect(() => {
    if (initialTechnicianIds.length) setSelectedIds(initialTechnicianIds.slice(0, 8));
  }, [initialTechnicianIds]); // route-driven selection from Map View

  const selectedTechnicians = useMemo(
    () => selectedIds.map((id) => technicians.find((tech) => tech.id === id)).filter((tech): tech is TechnicianRecord => Boolean(tech)),
    [selectedIds, technicians],
  );
  // Counts cover the full directory even when only one page is visible.
  const nameCounts = useMemo(() => buildTechnicianNameCounts(technicians), [technicians]);

  const filteredTechnicians = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return technicians;
    return technicians.filter((tech) =>
      [tech.name, tech.phone_number, tech.area, tech.service].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [search, technicians]);

  // Unnamed import rows have no name and often no area, which renders as a bare
  // separator. They sort last so they never crowd out named technicians.
  const sortedTechnicians = useMemo(
    () =>
      [...filteredTechnicians].sort((left, right) => {
        const leftNamed = left.name?.trim() ? 0 : 1;
        const rightNamed = right.name?.trim() ? 0 : 1;
        return leftNamed - rightNamed || (left.name ?? "").localeCompare(right.name ?? "");
      }),
    [filteredTechnicians],
  );

  const totalPages = Math.max(1, Math.ceil(sortedTechnicians.length / pickerPageSize));
  const currentPage = Math.min(pickerPage, totalPages);
  const pageStart = (currentPage - 1) * pickerPageSize;
  const visibleTechnicians = useMemo(
    () => sortedTechnicians.slice(pageStart, pageStart + pickerPageSize),
    [sortedTechnicians, pageStart, pickerPageSize],
  );

  // A new search or page size can leave the reader past the last page.
  useEffect(() => {
    setPickerPage(1);
  }, [search, pickerPageSize]);

  useEffect(() => {
    setAiResults({});
    setProposedLabels({});
    setAssessments({});
    setReports({});
    if (!selectedIds.length) {
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
    if (busy) return;
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
      if (results.length !== selectedIds.length) throw new Error("The report was incomplete. Please retry.");
      const indexed = Object.fromEntries(results.map((result) => [result.technicianId, result]));
      setAiResults(indexed);
      setProposedLabels((current) => ({ ...current, ...Object.fromEntries(results.filter((result) => !result.error).map((result) => [result.technicianId, result.labels])) }));
      setReports((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.technicianId, {
          technicianId: result.technicianId,
          jobsCompleted: result.jobCounts.completed,
          jobsPaid: result.jobCounts.paid,
          error: result.jobCounts.error,
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
      setFlagActions((current) => ({ ...current, [`${tech.id}:${changeType}`]: role === "admin" ? "applied" : "requested" }));
      if (role === "admin") void queryClient.invalidateQueries({ queryKey: TECHNICIANS_ROOT_KEY });
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
          <Button variant="outline" size="sm" onClick={() => setSelectedIds([])} disabled={!selectedIds.length || busy}>Clear</Button>
        </div>
        <div className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {visibleTechnicians.map((tech) => (
            <label key={tech.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted/60">
              <Checkbox checked={selectedIds.includes(tech.id)} disabled={busy} onCheckedChange={() => toggleTech(tech.id)} />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate">
                  {tech.name?.trim() || <span className="italic text-muted-foreground">Unnamed technician</span>}
                  <span className="text-muted-foreground">{tech.area ? ` · ${tech.area}` : ""}</span>
                </span>
                <TechnicianNameBadges tech={tech} nameCounts={nameCounts} />
              </span>
              {tech.is_active === false && <Badge variant="secondary">Inactive</Badge>}
            </label>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
          <span>
            {sortedTechnicians.length === 0
              ? "No technicians match this search."
              : `Showing ${pageStart + 1}–${Math.min(pageStart + pickerPageSize, sortedTechnicians.length)} of ${sortedTechnicians.length}${search.trim() ? " matching" : " technicians"}`}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              Per page
              <Select value={String(pickerPageSize)} onValueChange={(value) => setPickerPageSize(Number(value))}>
                <SelectTrigger className="h-7 w-[76px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PICKER_PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-7 px-2" disabled={currentPage === 1} onClick={() => setPickerPage(1)} title="First page" aria-label="First page">
                <ChevronsLeft className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2" disabled={currentPage === 1} onClick={() => setPickerPage((page) => Math.max(1, page - 1))} title="Previous page" aria-label="Previous page">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              {buildPickerPages(currentPage, totalPages).map((page, index) =>
                page === "ellipsis-left" || page === "ellipsis-right" ? (
                  <span key={`${page}-${index}`} className="px-1 text-muted-foreground">…</span>
                ) : (
                  <Button
                    key={page}
                    variant={page === currentPage ? "default" : "outline"}
                    size="sm"
                    className="h-7 min-w-7 px-2"
                    onClick={() => setPickerPage(page)}
                    aria-current={page === currentPage ? "page" : undefined}
                  >
                    {page}
                  </Button>
                ),
              )}
              <Button variant="outline" size="sm" className="h-7 px-2" disabled={currentPage === totalPages} onClick={() => setPickerPage((page) => Math.min(totalPages, page + 1))} title="Next page" aria-label="Next page">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2" disabled={currentPage === totalPages} onClick={() => setPickerPage(totalPages)} title="Last page" aria-label="Last page">
                <ChevronsRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
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
                <h3 className="flex flex-wrap items-center gap-1.5 font-semibold">
                  <span>{tech.name?.trim() || "Unnamed technician"}</span>
                  <TechnicianNameBadges tech={tech} nameCounts={nameCounts} />
                </h3>
                <p className="text-xs text-muted-foreground">{tech.service || "Service not set"} · {tech.area || "Area not set"} · {tech.phone_number || "No phone"}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">{report?.jobsCompleted ?? "—"} jobs completed</Badge>
                <Badge variant="outline">{report?.jobsPaid ?? "—"} jobs paid</Badge>
                {assessment?.last_assessed_at && <span className="text-muted-foreground">Reviewed {new Date(assessment.last_assessed_at).toLocaleString()}</span>}
              </div>
            </div>
            {report?.error && <p className="text-xs text-destructive">{report.error}</p>}
            {report?.countBasis && !report.error && <p className="text-[11px] text-muted-foreground">{report.countBasis}</p>}

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
                {(result?.evidence ?? assessment?.ai_evidence ?? []).map((item, index) => item.quote ? <blockquote key={index} className="border-l-2 border-primary/50 pl-2 text-xs italic text-muted-foreground">{item.source ? `${item.source}: ` : ""}{item.quote}</blockquote> : null)}
              </div>
            )}

            {recommendations.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Suggested next steps:</span>
                {recommendations.includes("suggest_inactive") && <Badge variant="outline">Review for inactivity</Badge>}
                {recommendations.includes("review_payment") && <Badge variant="outline">Review payment history</Badge>}
                {recommendations.includes("review_rates") && <Badge variant="outline">Review rates</Badge>}
                {recommendations.includes("suggest_check_job_message") && <Badge variant="outline">Compose job check-in</Badge>}
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t pt-3">
              {(recommendsInactive || labels.some((label) => ["tech_dont_respond", "tech_is_scammer", "never_responded"].includes(label))) && tech.is_active !== false && !flagActions[`${tech.id}:set_active`] && (
                <Button variant="outline" size="sm" disabled={actionBusyId === tech.id} onClick={() => void requestFlag(tech, "set_active", false)}><UserX className="mr-1.5 h-3.5 w-3.5" />{role === "admin" ? "Mark inactive" : "Request inactive"}</Button>
              )}
              {canComposeTechMessage && (recommendsMessage || labels.includes("good_tech")) && tech.phone_number && (
                <QuoPhoneTrigger contactName={tech.name} phone={tech.phone_number} chatType="tech" initialMessage={draft}>
                  <Button variant="outline" size="sm"><MessageSquareText className="mr-1.5 h-3.5 w-3.5" />Compose job check-in</Button>
                </QuoPhoneTrigger>
              )}
              {labels.includes("good_tech") && !tech.is_good_tech && !flagActions[`${tech.id}:set_good_tech`] && (
                <Button variant="outline" size="sm" disabled={actionBusyId === tech.id} onClick={() => void requestFlag(tech, "set_good_tech", true)}><Star className="mr-1.5 h-3.5 w-3.5" />{role === "admin" ? "Mark Good Tech" : "Request Good Tech"}</Button>
              )}
              {flagActions[`${tech.id}:set_active`] && <Badge variant="secondary">Inactive {flagActions[`${tech.id}:set_active`]}</Badge>}
              {flagActions[`${tech.id}:set_good_tech`] && <Badge variant="secondary">Good Tech {flagActions[`${tech.id}:set_good_tech`]}</Badge>}
            </div>
          </article>
        );
      })}
    </section>
  );
}
