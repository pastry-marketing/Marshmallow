import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { format, parseISO } from "date-fns";
import { AlertCircle, ChevronLeft, ChevronRight, MapPin, Radio, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { canViewLeadCoverageAnalytics } from "@/lib/access";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-paginate";
import {
  aggregateCoverage, COVERAGE_BUCKETS, COVERAGE_REPORT_COLORS, COVERAGE_REPORT_LABELS,
  coverageTrend, filterCoverageLeads, type CoverageAnalyticsLead, type CoverageGroup,
} from "@/lib/lead-coverage-analytics";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

const count = (value: number) => value.toLocaleString();
const EMPTY_ROWS: CoverageAnalyticsLead[] = [];
const share = (value: number, total: number) => `${total ? (value / total * 100).toFixed(1) : "0.0"}%`;
const TONES = {
  good: "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  normal: "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  bad: "border-rose-500/25 bg-rose-500/5 text-rose-700 dark:text-rose-300",
  unknown: "border-slate-500/25 bg-slate-500/5 text-slate-600 dark:text-slate-300",
};
const THRESHOLDS = { good: "10+ active technicians", normal: "1–9 active technicians", bad: "No active technicians", unknown: "Not resolved or not checked" };

function CoverageBreakdown({ title, description, groups, onChoose }: {
  title: string; description: string; groups: CoverageGroup[]; onChoose: (key: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const filtered = groups.filter((group) => group.label.toLowerCase().includes(search.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * 10;
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardContent className="p-0">
        <div className="space-y-3 p-5">
          <div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{description}</p></div>
          <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label={`Search ${title.toLowerCase()}`} placeholder="Search this breakdown…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="pl-9" /></div>
        </div>
        <Table>
          <TableHeader><TableRow><TableHead className="min-w-[180px]">{title === "Coverage by area" ? "Area" : "Source / phone line"}</TableHead><TableHead className="text-right">Total</TableHead>{COVERAGE_BUCKETS.map((bucket) => <TableHead key={bucket} className="text-right"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: COVERAGE_REPORT_COLORS[bucket] }} />{bucket === "unknown" ? "Unknown" : bucket[0].toUpperCase() + bucket.slice(1)}</span></TableHead>)}<TableHead className="text-right">Share</TableHead></TableRow></TableHeader>
          <TableBody>
            {filtered.slice(start, start + 10).map((group) => <TableRow key={group.key}><TableCell><button type="button" onClick={() => onChoose(group.key)} className="text-left text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Filter this report">{group.label}</button></TableCell><TableCell className="text-right font-semibold tabular-nums">{count(group.total)}</TableCell>{COVERAGE_BUCKETS.map((bucket) => <TableCell key={bucket} className="text-right tabular-nums">{count(group[bucket])}</TableCell>)}<TableCell className="text-right tabular-nums text-muted-foreground">{share(group.total, total)}</TableCell></TableRow>)}
            {!filtered.length && <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No matching rows.</TableCell></TableRow>}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground"><span>{filtered.length ? `${start + 1}–${Math.min(start + 10, filtered.length)} of ${filtered.length}` : "0 rows"} · Click an area or source to filter the report</span><div className="flex items-center gap-2"><Button variant="outline" size="icon" className="h-7 w-7" aria-label={`Previous page in ${title}`} disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button><span>{currentPage}/{pages}</span><Button variant="outline" size="icon" className="h-7 w-7" aria-label={`Next page in ${title}`} disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button></div></div>
      </CardContent>
    </Card>
  );
}

export function LeadCoverageSources({ startMs, endMs, rangeError }: { startMs: number; endMs: number; rangeError?: string | null }) {
  const { role, user } = useAuth();
  const allowed = canViewLeadCoverageAnalytics(role);
  const effectiveRangeError = rangeError || (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    ? "Choose valid start and end dates."
    : startMs > endMs ? "Start date must be on or before the end date." : null);
  const [selection, setSelection] = useState({ range: "", source: "all", area: "all" });
  const rangeKey = `${startMs}:${endMs}`;
  // Date changes reset dimension filters without an effect-driven stale render.
  const sourceKey = selection.range === rangeKey ? selection.source : "all";
  const areaKey = selection.range === rangeKey ? selection.area : "all";
  const choose = (dimension: "source" | "area", value: string) => setSelection({ range: rangeKey, source: sourceKey, area: areaKey, [dimension]: value });
  const query = useQuery({
    queryKey: ["admin-lead-coverage-sources", user?.id, startMs, endMs],
    enabled: allowed && !effectiveRangeError,
    queryFn: async ({ signal }) => {
      if (!allowed) throw new Error("This report is available to Admins only.");
      // Existing authenticated leads SELECT RLS is preserved. No service-role
      // credentials or new cross-role data access is introduced by this report.
      return fetchAllRows<CoverageAnalyticsLead>((from, to) => supabase.from("leads")
        .select("id, created_at, coverage_level, coverage_area_label, city, state, number_name")
        .gte("created_at", new Date(startMs).toISOString()).lte("created_at", new Date(endMs).toISOString())
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .range(from, to).abortSignal(signal));
    },
  });
  const rows = query.data ?? EMPTY_ROWS;
  const options = useMemo(() => aggregateCoverage(rows), [rows]);
  const filtered = useMemo(() => filterCoverageLeads(rows, sourceKey, areaKey), [rows, sourceKey, areaKey]);
  const report = useMemo(() => aggregateCoverage(filtered), [filtered]);
  const trend = useMemo(() => coverageTrend(filtered, startMs, endMs), [filtered, startMs, endMs]);
  if (!allowed) return null;
  if (effectiveRangeError) return <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">{effectiveRangeError}</div>;
  if (query.isPending) return <div role="status" aria-label="Loading coverage report" className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div><Skeleton className="h-80 rounded-2xl" /></div>;
  if (query.isError) return <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-5"><p className="flex items-center gap-2 font-semibold"><AlertCircle className="h-4 w-4" />Could not load the coverage report</p><p className="mt-2 text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-3" variant="outline" onClick={() => void query.refetch()}>Try again</Button></div>;
  const { totals } = report;
  return (
    <section className="space-y-5" aria-label="Lead Coverage & Sources report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="mb-1 flex items-center gap-2 text-xs font-medium text-primary"><ShieldCheck className="h-3.5 w-3.5" />Admin report</div><h2 className="text-xl font-semibold tracking-tight">Lead Coverage &amp; Sources</h2><p className="mt-1 text-sm text-muted-foreground">Understand where jobs arrive, how well those areas are covered, and which phone lines generate demand.</p></div>
        <div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">Updated {format(query.dataUpdatedAt, "h:mm a")}</span><Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw className={`mr-2 h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />Refresh</Button></div>
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border bg-card p-4">
        <div className="min-w-[220px] flex-1 space-y-1.5"><label htmlFor="coverage-source" className="flex items-center gap-1.5 text-xs font-medium"><Radio className="h-3.5 w-3.5" />Source / phone line</label><Select value={sourceKey} onValueChange={(value) => choose("source", value)}><SelectTrigger id="coverage-source"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All sources</SelectItem>{options.sources.map((group) => <SelectItem key={group.key} value={group.key}>{group.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="min-w-[220px] flex-1 space-y-1.5"><label htmlFor="coverage-area" className="flex items-center gap-1.5 text-xs font-medium"><MapPin className="h-3.5 w-3.5" />Area</label><Select value={areaKey} onValueChange={(value) => choose("area", value)}><SelectTrigger id="coverage-area"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All areas</SelectItem>{options.areas.map((group) => <SelectItem key={group.key} value={group.key}>{group.label}</SelectItem>)}</SelectContent></Select></div>
        <Button variant="ghost" disabled={sourceKey === "all" && areaKey === "all"} onClick={() => setSelection({ range: rangeKey, source: "all", area: "all" })}>Reset filters</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card className="rounded-2xl border-primary/20 bg-primary/5"><CardContent className="p-5"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total incoming jobs</p><p className="mt-3 text-3xl font-bold tabular-nums">{count(totals.total)}</p><p className="mt-2 text-xs text-muted-foreground">Lead records created in this period</p></CardContent></Card>
        {COVERAGE_BUCKETS.map((bucket) => <Card key={bucket} className={`rounded-2xl ${TONES[bucket]}`}><CardContent className="p-5"><p className="text-xs font-semibold uppercase tracking-wider">{COVERAGE_REPORT_LABELS[bucket]}</p><div className="mt-3 flex items-end justify-between gap-2"><p className="text-3xl font-bold tabular-nums">{count(totals[bucket])}</p><span className="text-sm font-semibold tabular-nums">{share(totals[bucket], totals.total)}</span></div><p className="mt-2 text-xs">{THRESHOLDS[bucket]}</p></CardContent></Card>)}
      </div>
      <div className="rounded-xl border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground"><strong className="text-foreground">Report basis:</strong> intake date is the lead creation date; coverage is the latest stored classification within 40 miles, not a historical snapshot at intake. Sources are recorded phone-line names, not verified advertising channels. Unknown coverage is included in totals and percentages.{totals.unknown > 0 && <span className="mt-1 block"><strong className="text-foreground">Data quality:</strong> {count(totals.unknown)} jobs ({share(totals.unknown, totals.total)}) have unresolved or unchecked coverage. They are not counted as Bad Coverage.</span>}</div>
      {!totals.total ? <div className="rounded-2xl border border-dashed p-10 text-center"><MapPin className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /><h3 className="font-semibold">No incoming jobs match these filters</h3><p className="mt-1 text-sm text-muted-foreground">Try a wider date range or reset the source and area filters.</p></div> : <>
        <Card className="rounded-2xl"><CardContent className="p-5"><h3 className="font-semibold">Coverage mix over time</h3><p className="mt-1 text-xs text-muted-foreground">Incoming jobs grouped by {trend.granularity}. Counts use the same date, source, and area filters as the tables.</p><div className="mt-5 h-[300px]" role="img" aria-label="Stacked bar chart of incoming jobs by coverage; exact totals are in the cards and tables"><ResponsiveContainer width="100%" height="100%"><BarChart data={trend.points}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} /><XAxis dataKey="date" tickFormatter={(value: string) => format(parseISO(value), trend.granularity === "month" ? "MMM yy" : "MMM d")} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} minTickGap={25} /><YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} /><Tooltip labelFormatter={(value) => format(parseISO(String(value)), "MMM d, yyyy")} contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: 12, color: "hsl(var(--foreground))" }} /><Legend wrapperStyle={{ fontSize: 12, paddingTop: 15 }} />{COVERAGE_BUCKETS.map((bucket) => <Bar key={bucket} dataKey={bucket} name={COVERAGE_REPORT_LABELS[bucket]} stackId="coverage" fill={COVERAGE_REPORT_COLORS[bucket]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer></div></CardContent></Card>
        <div className="grid gap-5 2xl:grid-cols-2"><CoverageBreakdown key={`areas:${rangeKey}:${sourceKey}:${areaKey}`} title="Coverage by area" description="Find high-demand areas with limited technician coverage." groups={report.areas} onChoose={(value) => choose("area", value)} /><CoverageBreakdown key={`sources:${rangeKey}:${sourceKey}:${areaKey}`} title="Coverage by source" description="Compare intake phone lines across all four coverage groups." groups={report.sources} onChoose={(value) => choose("source", value)} /></div>
      </>}
    </section>
  );
}
