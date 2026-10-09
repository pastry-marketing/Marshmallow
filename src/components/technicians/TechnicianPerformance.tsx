import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, MapPin, RefreshCw, Search, Star } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { TechnicianNameBadges } from "@/components/technicians/TechnicianNameCell";
import { buildTechnicianNameCounts } from "@/lib/technician-names";
import { fetchAllTechnicians, TECHNICIANS_ROOT_KEY } from "@/lib/technicians";
import {
  fetchTechPerformance,
  groupByArea,
  summariseTechPerformance,
  techPerformanceToCsv,
  type TechPerformanceRow,
} from "@/lib/tech-performance";

type SortKey = "paid" | "rate" | "cancelled" | "name";

const RANGE_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="border-border/60 bg-card/95">
      <CardContent className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-foreground">{value}</p>
        {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Technician outcomes, shown as a tab on the Technicians page.
 *
 * Distinct from the OPR Report next to it: that one counts technicians each
 * OPR has added. This one measures what happened after the work was taken, by
 * technician and by area.
 */
export function TechnicianPerformance() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState("all");
  const [query, setQuery] = useState("");
  const [goodOnly, setGoodOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("paid");

  const from = useMemo(() => {
    if (range === "all") return null;
    const days = Number(range);
    if (!Number.isFinite(days)) return null;
    return new Date(Date.now() - days * 86400000).toISOString();
  }, [range]);

  const perfQuery = useQuery({
    queryKey: ["tech-performance", from],
    queryFn: () => fetchTechPerformance({ from }),
  });

  // Every figure on this page, and the Good Tech toggle, are matched by name.
  // Rows sharing a name therefore merge, so the name is flagged.
  const nameCountsQuery = useQuery({
    queryKey: TECHNICIANS_ROOT_KEY,
    queryFn: fetchAllTechnicians,
    staleTime: 60_000,
  });
  const nameCounts = useMemo(() => buildTechnicianNameCounts(nameCountsQuery.data ?? []), [nameCountsQuery.data]);

  // is_good_tech is only settable by an admin, matching the Technicians page.
  const toggleGoodTech = useMutation({
    mutationFn: async ({ techName, next }: { techName: string; next: boolean }) => {
      // Names are duplicated in technicians (2,671 rows over 1,177 distinct
      // names), so every row sharing the name is updated. That keeps the flag
      // consistent with how this page groups by name.
      const { error } = await supabase
        .from("technicians")
        .update({ is_good_tech: next } as never)
        .ilike("name", techName);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tech-performance"] });
    },
    onError: (err: Error) => toast.error(`Could not update Good Tech: ${err.message}`),
  });

  // Wrapped rather than `perfQuery.data ?? []` inline: an empty array literal is
  // a new value on every render, which would defeat the memoised rollups below.
  const rows = useMemo(() => perfQuery.data ?? [], [perfQuery.data]);

  const summary = useMemo(() => summariseTechPerformance(rows), [rows]);
  const areaGroups = useMemo(() => groupByArea(rows), [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (goodOnly && !row.good_tech) return false;
      if (!needle) return true;
      return (
        row.tech_name?.toLowerCase().includes(needle) ||
        row.location_label?.toLowerCase().includes(needle) ||
        row.opr_code?.toLowerCase().includes(needle)
      );
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === "name") return (a.tech_name ?? "").localeCompare(b.tech_name ?? "");
      if (sort === "rate") return (b.paid_rate_pct ?? -1) - (a.paid_rate_pct ?? -1);
      if (sort === "cancelled") return (b.cancelled_count ?? 0) - (a.cancelled_count ?? 0);
      return (b.paid_count ?? 0) - (a.paid_count ?? 0);
    });
    return sorted;
  }, [rows, query, goodOnly, sort]);

  const handleExport = () => {
    const csv = techPerformanceToCsv(visible);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `technician-performance-${range}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
            Technician performance
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Paid against cancelled work for every technician who has taken a job, so you can
            see who converts and where. Cancelled counts are shown next to paid on purpose:
            a technician with few jobs but no cancellations is a different signal from one
            with the same paid count and several cancellations.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="h-10 w-[160px] text-xs" aria-label="Date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => perfQuery.refetch()}
            disabled={perfQuery.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${perfQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" className="gap-1.5" onClick={handleExport} disabled={!visible.length}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </header>

      {perfQuery.isError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-5 text-sm text-destructive">
            Could not load technician performance. If the database migration has not been run
            yet, the <code>tech_paid_performance</code> function does not exist. Run{" "}
            <code>supabase/migrations/20261030120000_tech_paid_performance.sql</code> in the SQL
            Editor, then refresh.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {perfQuery.isPending ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-2xl" />
          ))
        ) : (
          <>
            <StatCard
              label="Paid jobs"
              value={String(summary.paidTotal)}
              hint={`${summary.scheduledTotal} scheduled`}
            />
            <StatCard
              label="Paid rate"
              value={summary.overallPaidRate === null ? "—" : `${summary.overallPaidRate}%`}
              hint="paid / (paid + cancelled)"
            />
            <StatCard label="Cancelled" value={String(summary.cancelledTotal)} hint="after a tech was assigned" />
            <StatCard
              label="Technicians"
              value={String(summary.technicians)}
              hint="took at least one job"
            />
            <StatCard
              label="Good Techs"
              value={String(summary.goodTechCount)}
              hint={summary.goodTechCount === 0 ? "none flagged yet" : "flagged manually"}
            />
          </>
        )}
      </div>

      <Card className="overflow-hidden border-border/60 bg-card/95">
        <CardContent className="p-0">
          <div className="flex flex-col gap-3 border-b border-border/50 bg-background/45 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[220px] flex-1 lg:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search technician, area or OPR"
                  className="h-10 pl-9 text-xs"
                  aria-label="Search technicians"
                />
              </div>
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger className="h-10 w-[170px] text-xs" aria-label="Sort by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid">Most paid</SelectItem>
                  <SelectItem value="rate">Highest paid rate</SelectItem>
                  <SelectItem value="cancelled">Most cancelled</SelectItem>
                  <SelectItem value="name">Name A–Z</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex h-10 items-center gap-2 rounded-2xl border border-border/60 bg-background/70 px-3 text-[12px]">
                <Switch checked={goodOnly} onCheckedChange={setGoodOnly} />
                Good Tech only
              </label>
            </div>
            <span className="text-[11px] font-medium text-muted-foreground">
              {visible.length} of {rows.length} technicians
            </span>
          </div>

          {perfQuery.isPending ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </div>
          ) : !visible.length ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              {rows.length
                ? "No technicians match these filters."
                : "No technician has taken a job yet."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-sm">
                <thead className="bg-muted/20">
                  <tr className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                    <th scope="col" className="px-5 py-3 text-left font-semibold">Technician</th>
                    <th scope="col" className="px-5 py-3 text-left font-semibold">Area</th>
                    <th scope="col" className="px-5 py-3 text-left font-semibold">OPR</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Paid</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Cancelled</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Scheduled</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Paid rate</th>
                    <th scope="col" className="px-5 py-3 text-center font-semibold">Good Tech</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row: TechPerformanceRow) => (
                    <tr key={`${row.tech_name}-${row.location_label}`} className="border-t border-border/40">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2 font-medium text-foreground">
                          <span className="truncate">{row.tech_name}</span>
                          <TechnicianNameBadges tech={{ name: row.tech_name }} nameCounts={nameCounts} />
                          {row.good_tech ? (
                            <Star className="h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500" />
                          ) : null}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-[12px] text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <MapPin className="h-3 w-3 shrink-0 opacity-60" />
                          <span className="truncate" title={row.location_label}>
                            {row.location_label}
                          </span>
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {row.opr_code ? (
                          <code className="rounded-md border border-border/40 bg-muted/60 px-2 py-0.5 font-mono text-[11px]">
                            {row.opr_code}
                          </code>
                        ) : (
                          <span className="text-[12px] text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right font-semibold tabular-nums">{row.paid_count}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{row.cancelled_count}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{row.scheduled_count}</td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {row.paid_rate_pct === null ? (
                          <span className="text-muted-foreground/50">—</span>
                        ) : (
                          <Badge
                            variant="outline"
                            className={
                              row.paid_rate_pct >= 70
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                                : row.paid_rate_pct >= 40
                                  ? "border-border/60 bg-muted/40 text-foreground"
                                  : "border-destructive/30 bg-destructive/10 text-destructive"
                            }
                          >
                            {row.paid_rate_pct}%
                          </Badge>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-center">
                          <Switch
                            checked={row.good_tech}
                            disabled={toggleGoodTech.isPending}
                            onCheckedChange={(next) =>
                              toggleGoodTech.mutate({ techName: row.tech_name, next })
                            }
                            aria-label={`Mark ${row.tech_name} as Good Tech`}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/60 bg-card/95">
        <CardContent className="p-0">
          <div className="flex flex-col gap-1 border-b border-border/50 bg-background/45 px-5 py-4">
            <span className="text-sm font-semibold text-foreground">Where the paid work is</span>
            <span className="text-[12px] text-muted-foreground">
              Grouped by state and zip. City is deliberately not used: the address text is
              only reliably readable for the comma-delimited rows, so a city grouping would
              mix real cities with whole street addresses and give numbers that look
              authoritative but are not.
              {summary.approximateLocationCount > 0
                ? ` ${summary.approximateLocationCount} of ${summary.technicians} technicians resolved to a state or zip rather than a city.`
                : ""}
            </span>
          </div>
          {areaGroups.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/20">
                  <tr className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                    <th scope="col" className="px-5 py-3 text-left font-semibold">Area</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Technicians</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Paid</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Cancelled</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Paid rate</th>
                  </tr>
                </thead>
                <tbody>
                  {areaGroups.slice(0, 40).map((group) => (
                    <tr key={group.key} className="border-t border-border/40">
                      <td className="px-5 py-3 font-medium text-foreground">{group.key}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{group.technicians}</td>
                      <td className="px-5 py-3 text-right tabular-nums font-semibold">{group.paid}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{group.cancelled}</td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {group.paidRate === null ? (
                          <span className="text-muted-foreground/50">—</span>
                        ) : (
                          `${group.paidRate}%`
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No area could be resolved from this selection.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
