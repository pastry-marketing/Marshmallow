import React, { useEffect, useState } from "react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { CalendarIcon, Download } from "lucide-react";
import { DateRange } from "react-day-picker";

export interface ExportOptions {
  format: "csv" | "xlsx";
  dateRangePreset: "all_time" | "today" | "yesterday" | "7d" | "30d" | "custom";
  customDateRange: DateRange | undefined;
  scope: "all" | "current";
  status: string;
  limit: number | "all";
}

export interface StatusExportOption {
  value: string;
  label: string;
}

interface ExportLeadsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (options: ExportOptions) => Promise<void>;
  isExporting: boolean;
  totalFiltered: number;
  statusOptions: StatusExportOption[];
  /** The status tab currently open, used as the default status for the export. */
  currentStatus: string;
}

export default function ExportLeadsDialog({
  open,
  onOpenChange,
  onExport,
  isExporting,
  totalFiltered,
  statusOptions,
  currentStatus,
}: ExportLeadsDialogProps) {
  const [formatType, setFormatType] = useState<"csv" | "xlsx">("csv");
  const [dateRangePreset, setDateRangePreset] = useState<ExportOptions["dateRangePreset"]>("all_time");
  const [customDateRange, setCustomDateRange] = useState<DateRange | undefined>();
  const [scope, setScope] = useState<"all" | "current">("current");
  const [status, setStatus] = useState<string>(currentStatus);
  const [limit, setLimit] = useState<number | "all">("all");

  // Default the export to whichever status section the user opened it from.
  useEffect(() => {
    if (open) setStatus(currentStatus);
  }, [open, currentStatus]);

  const handleExport = () => {
    onExport({
      format: formatType,
      dateRangePreset,
      customDateRange,
      scope,
      status,
      limit,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px] rounded-3xl border border-border/60 bg-card/95 shadow-brand backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Export Leads</DialogTitle>
          <DialogDescription>
            Configure how you want to export your lead data.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-4">
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Format</Label>
            <Select value={formatType} onValueChange={(v: "csv" | "xlsx") => setFormatType(v)}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="Select format" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV (Comma separated)</SelectItem>
                <SelectItem value="xlsx">XLSX (Excel Spreadsheet)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Leads to Include</Label>
            <Select value={scope} onValueChange={(v: "all" | "current") => setScope(v)}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current Search & Filters ({totalFiltered} leads)</SelectItem>
                <SelectItem value="all">Entire Database (All Leads)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {statusOptions.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Created Date Range</Label>
            <Select value={dateRangePreset} onValueChange={(v: ExportOptions["dateRangePreset"]) => setDateRangePreset(v)}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="Select date range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_time">All Time</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="yesterday">Yesterday</SelectItem>
                <SelectItem value="7d">Last 7 Days</SelectItem>
                <SelectItem value="30d">Last 30 Days</SelectItem>
                <SelectItem value="custom">Custom Date Range</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {dateRangePreset === "custom" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Select Range</Label>
              <div className="grid gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      id="date"
                      variant={"outline"}
                      className={cn(
                        "w-full justify-start text-left font-normal h-10",
                        !customDateRange && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4 opacity-50" />
                      {customDateRange?.from ? (
                        customDateRange.to ? (
                          <>
                            {format(customDateRange.from, "LLL dd, y")} -{" "}
                            {format(customDateRange.to, "LLL dd, y")}
                          </>
                        ) : (
                          format(customDateRange.from, "LLL dd, y")
                        )
                      ) : (
                        <span>Pick a date range</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="center">
                    <Calendar
                      initialFocus
                      mode="range"
                      defaultMonth={customDateRange?.from}
                      selected={customDateRange}
                      onSelect={setCustomDateRange}
                      numberOfMonths={1}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Maximum Leads</Label>
            <Select value={limit.toString()} onValueChange={(v) => setLimit(v === "all" ? "all" : parseInt(v))}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="Select limit" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50 Leads</SelectItem>
                <SelectItem value="100">100 Leads</SelectItem>
                <SelectItem value="500">500 Leads</SelectItem>
                <SelectItem value="all">All Available</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isExporting}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || (dateRangePreset === "custom" && !customDateRange?.from)}>
            {isExporting ? "Exporting..." : "Export Data"}
            {!isExporting && <Download className="ml-2 h-4 w-4" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
