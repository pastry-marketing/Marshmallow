import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import type { DateRange } from "react-day-picker";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-paginate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CalendarDays, ChevronDown, Download, Loader2, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";

interface OprCodeOption {
  opr_code: string;
  full_name: string | null;
}

interface ReportRow {
  opr_code: string;
  owner: string;
  count: number;
}

function toStartOfDayISO(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
function toEndOfDayISO(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}
function isoDate(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

function localDate(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00`);
}

type DatePreset = "today" | "yesterday" | "last_week" | "last_month" | "custom";

const DATE_PRESETS: Array<{ value: Exclude<DatePreset, "custom">; label: string; daysAgo: number }> = [
  { value: "today", label: "Today", daysAgo: 0 },
  { value: "yesterday", label: "Yesterday", daysAgo: 1 },
  { value: "last_week", label: "Last Week", daysAgo: 6 },
  { value: "last_month", label: "Last Month", daysAgo: 29 },
];

/**
 * Per-OPR technician report: how many technicians each OPR / OPR admin added
 * within a custom date range. Admins can export it.
 */
export function TechnicianReport({ isAdmin }: { isAdmin: boolean }) {
  const today = new Date();
  const monthAgo = subDays(today, 29);

  const [from, setFrom] = useState(isoDate(monthAgo));
  const [to, setTo] = useState(isoDate(today));
  const [activePreset, setActivePreset] = useState<DatePreset>("last_month");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [draftRange, setDraftRange] = useState<DateRange>({
    from: localDate(from),
    to: localDate(to),
  });

  const applyPreset = (preset: Exclude<DatePreset, "custom">, daysAgo: number) => {
    const anchor = new Date();
    const end = preset === "yesterday" ? subDays(anchor, 1) : anchor;
    const start = preset === "yesterday" ? end : subDays(anchor, daysAgo);
    setFrom(isoDate(start));
    setTo(isoDate(end));
    setDraftRange({ from: start, to: end });
    setActivePreset(preset);
    setCalendarOpen(false);
  };

  const applyCustomRange = (range: DateRange | undefined) => {
    if (!range?.from) return;
    setDraftRange(range);
    setFrom(isoDate(range.from));
    setTo(isoDate(range.to ?? range.from));
    setActivePreset("custom");
    if (range.to) setCalendarOpen(false);
  };

  const { data: ownerMap = new Map<string, string>() } = useQuery({
    queryKey: ["opr-code-owners"],
    queryFn: async () => {
      const { data } = await supabase.rpc("list_opr_codes" as never);
      const rows = (data ?? []) as OprCodeOption[];
      return new Map(rows.map((r) => [r.opr_code, r.full_name ?? ""]));
    },
    staleTime: 60_000,
  });

  const reportQuery = useQuery({
    queryKey: ["tech-report", from, to],
    queryFn: async () => {
      // Page through so the counts/export cover every technician in the range,
      // not just the first 1000 (PostgREST's default response cap).
      const data = await fetchAllRows<{ opr_code: string | null }>((rangeFrom, rangeTo) =>
        supabase
          .from("technicians")
          .select("opr_code, created_at")
          .gte("created_at", toStartOfDayISO(from))
          .lte("created_at", toEndOfDayISO(to))
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(rangeFrom, rangeTo),
      );
      const counts = new Map<string, number>();
      for (const row of data) {
        const code = (row.opr_code || "").trim() || "Unassigned";
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      return counts;
    },
    enabled: Boolean(from && to),
  });

  const rows = useMemo<ReportRow[]>(() => {
    const counts = reportQuery.data ?? new Map<string, number>();
    return Array.from(counts.entries())
      .map(([opr_code, count]) => ({
        opr_code,
        owner: opr_code === "Unassigned" ? "" : ownerMap.get(opr_code) ?? "",
        count,
      }))
      .sort((a, b) => b.count - a.count || a.opr_code.localeCompare(b.opr_code));
  }, [reportQuery.data, ownerMap]);

  const total = rows.reduce((sum, r) => sum + r.count, 0);

  const exportReport = (format: "csv" | "xlsx") => {
    const headers = ["OPR Code", "Owner", "Technicians Added"];
    const body = rows.map((r) => ({
      "OPR Code": r.opr_code,
      Owner: r.owner,
      "Technicians Added": r.count,
    }));
    const ws = XLSX.utils.json_to_sheet(body, { header: headers });
    const range = `${from}_to_${to}`;
    if (format === "csv") {
      const csv = XLSX.utils.sheet_to_csv(ws);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      triggerDownload(blob, `technician-report_${range}.csv`);
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Report");
      const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      triggerDownload(new Blob([buf], { type: "application/octet-stream" }), `technician-report_${range}.xlsx`);
    }
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="overflow-hidden rounded-2xl border-border/60 bg-card/90 shadow-sm">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <UsersRound className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Technician activity</h2>
              <p className="text-xs text-muted-foreground">Technicians added by each OPR during the selected period.</p>
            </div>
          </div>
          {isAdmin && rows.length > 0 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-8 rounded-lg border-border/60 text-xs" onClick={() => exportReport("csv")}>
                <Download className="mr-1.5 h-4 w-4" /> CSV
              </Button>
              <Button variant="outline" size="sm" className="h-8 rounded-lg border-border/60 text-xs" onClick={() => exportReport("xlsx")}>
                <Download className="mr-1.5 h-4 w-4" /> XLSX
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-b border-border/50 bg-muted/20 p-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Quick filters</span>
            <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-background/80 p-1">
              {DATE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  aria-pressed={activePreset === preset.value}
                  onClick={() => applyPreset(preset.value, preset.daysAgo)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    activePreset === preset.value
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <Popover
              open={calendarOpen}
              onOpenChange={(open) => {
                setCalendarOpen(open);
                if (open) setDraftRange({ from: localDate(from), to: localDate(to) });
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "h-9 min-w-[238px] justify-between rounded-xl border-border/60 bg-background px-3 text-xs font-medium",
                    activePreset === "custom" && "border-primary/60 bg-primary/5 text-primary",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <CalendarDays className="h-4 w-4" />
                    {format(localDate(from), "MMM d, yyyy")} – {format(localDate(to), "MMM d, yyyy")}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto rounded-xl border-border/60 p-0 shadow-xl" align="start">
                <Calendar
                  initialFocus
                  mode="range"
                  defaultMonth={draftRange.from}
                  selected={draftRange}
                  onSelect={applyCustomRange}
                  numberOfMonths={1}
                  disabled={{ after: new Date() }}
                  className="pointer-events-auto p-3"
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {reportQuery.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Loading report…</>
            ) : (
              <>
                <span className="rounded-lg border border-border/60 bg-background px-2.5 py-1.5">
                  <strong className="text-foreground">{total.toLocaleString()}</strong> technician{total === 1 ? "" : "s"}
                </span>
                <span className="rounded-lg border border-border/60 bg-background px-2.5 py-1.5">
                  <strong className="text-foreground">{rows.length}</strong> OPR{rows.length === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="m-4 overflow-x-auto rounded-xl border border-border/60">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-10 text-[11px] font-semibold uppercase tracking-wider">OPR Code</TableHead>
                <TableHead className="h-10 text-[11px] font-semibold uppercase tracking-wider">Owner</TableHead>
                <TableHead className="h-10 text-right text-[11px] font-semibold uppercase tracking-wider">Technicians Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reportQuery.isPending && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </TableCell>
                </TableRow>
              )}
              {!reportQuery.isPending && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    No technicians were added in this date range.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.opr_code} className="transition-colors hover:bg-muted/30">
                  <TableCell className="font-mono text-xs font-semibold tracking-wider">{r.opr_code}</TableCell>
                  <TableCell>{r.owner || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex min-w-10 justify-center rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                      {r.count.toLocaleString()}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
