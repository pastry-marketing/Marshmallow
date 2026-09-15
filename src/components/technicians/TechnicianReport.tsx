import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-paginate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Loader2 } from "lucide-react";

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
  return d.toISOString().slice(0, 10);
}

/**
 * Per-OPR technician report: how many technicians each OPR / OPR admin added
 * within a custom date range. Admins can export it.
 */
export function TechnicianReport({ isAdmin }: { isAdmin: boolean }) {
  const today = new Date();
  const monthAgo = new Date();
  monthAgo.setDate(today.getDate() - 30);

  const [from, setFrom] = useState(isoDate(monthAgo));
  const [to, setTo] = useState(isoDate(today));

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
    <Card className="border-border/60">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="report-from" className="text-xs text-muted-foreground">From</Label>
              <Input id="report-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[160px] text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-to" className="text-xs text-muted-foreground">To</Label>
              <Input id="report-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-[160px] text-sm" />
            </div>
          </div>
          {isAdmin && rows.length > 0 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => exportReport("csv")}>
                <Download className="mr-1.5 h-4 w-4" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => exportReport("xlsx")}>
                <Download className="mr-1.5 h-4 w-4" /> XLSX
              </Button>
            </div>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {reportQuery.isPending
            ? "Loading…"
            : `${total.toLocaleString()} technician${total === 1 ? "" : "s"} added across ${rows.length} OPR${rows.length === 1 ? "" : "s"} in this range.`}
        </p>

        <div className="overflow-x-auto rounded-lg border border-border/60">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>OPR Code</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Technicians Added</TableHead>
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
                <TableRow key={r.opr_code}>
                  <TableCell className="font-mono text-xs font-semibold tracking-wider">{r.opr_code}</TableCell>
                  <TableCell>{r.owner || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right font-medium">{r.count.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
