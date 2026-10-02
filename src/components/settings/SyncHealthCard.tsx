import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import {
  claimSyncQueue,
  describeSyncStatus,
  fetchSyncHealth,
  formatSyncAge,
  pruneSyncErrorLog,
  type SyncStatus,
} from "@/lib/sheets-sync-health";

/**
 * Live state of the Google Sheets sync.
 *
 * Reads from the database rather than from component state, because sync runs
 * in someone's browser. Anything held only here is true for exactly as long as
 * this tab stays open, which is the opposite of what a health indicator should
 * tell you - the tab closing is one of the ways sync breaks.
 *
 * The status is computed in SQL from the last success, so a sync that stopped
 * without recording anything still shows as degraded instead of healthy.
 */
export function SyncHealthCard() {
  const queryClient = useQueryClient();
  const [showErrors, setShowErrors] = useState(false);

  const healthQuery = useQuery({
    queryKey: ["google-sheets-sync-health"],
    queryFn: () => fetchSyncHealth(),
    refetchInterval: 30_000,
    // Health that is 30s old is still the truth for a system whose failures
    // take minutes to notice, so a background refresh is not worth the noise.
    refetchIntervalInBackground: false,
  });

  const retryQueue = useMutation({
    mutationFn: async () => {
      const claimed = await claimSyncQueue(50);
      return claimed.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["google-sheets-sync-health"] });
      toast.success(
        count > 0
          ? `Processing ${count} queued lead${count === 1 ? "" : "s"}`
          : "Nothing is waiting to sync",
      );
    },
    onError: (err: Error) => toast.error(`Could not read the retry queue: ${err.message}`),
  });

  const pruneLog = useMutation({
    mutationFn: () => pruneSyncErrorLog(500),
    onSuccess: (removed) => {
      queryClient.invalidateQueries({ queryKey: ["google-sheets-sync-health"] });
      toast.success(`Removed ${removed} old error${removed === 1 ? "" : "s"}`);
    },
    onError: (err: Error) => toast.error(`Could not prune the error log: ${err.message}`),
  });

  const health = healthQuery.data;
  const status: SyncStatus = health?.status ?? "idle";
  const tone = describeSyncStatus(status);
  const isProblem = status === "degraded" || status === "down";

  const statusIcon = {
    healthy: <CheckCircle2 className="h-4 w-4" />,
    degraded: <AlertTriangle className="h-4 w-4" />,
    down: <AlertCircle className="h-4 w-4" />,
    idle: <CircleSlash className="h-4 w-4" />,
  }[status];

  return (
    <Card className="glass-panel border-border/60">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Activity className="h-4 w-4 text-primary" />
              Sync Health
            </CardTitle>
            <CardDescription className="text-xs">
              Recorded in the database, so it stays accurate after the browser closes.
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`gap-1.5 border-border/50 bg-muted/40 ${tone.tone}`}
            >
              {statusIcon}
              {tone.label}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ["google-sheets-sync-health"] })}
              aria-label="Refresh sync health"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${healthQuery.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {healthQuery.isError ? (
          <p className="text-sm text-destructive">
            Could not read sync health. If the sync health migration has not been applied,
            the <code>get_sheets_sync_health</code> function does not exist.
          </p>
        ) : healthQuery.isPending ? (
          <div className="grid gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/60" />
            ))}
          </div>
        ) : (
          <>
            {isProblem ? (
              <div
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
                role="status"
              >
                {status === "down"
                  ? "Sync has failed repeatedly. Leads are being queued and will retry automatically."
                  : "Sync is not keeping up. Queued leads will retry automatically."}
                {health?.last_error_message ? (
                  <p className="mt-1 opacity-80">Last error: {health.last_error_message}</p>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-4">
              <Stat
                label="Last success"
                value={formatSyncAge(health?.seconds_since_success ?? null)}
              />
              <Stat
                label="Failed attempts"
                value={String(health?.consecutive_failures ?? 0)}
                tone={(health?.consecutive_failures ?? 0) > 0 ? tone.tone : undefined}
              />
              <Stat
                label="Leads queued"
                value={String(health?.queue_depth ?? 0)}
                tone={(health?.queue_depth ?? 0) > 0 ? tone.tone : undefined}
              />
              <Stat label="Leads synced" value={String(health?.synced_total ?? 0)} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={retryQueue.isPending}
                onClick={() => retryQueue.mutate()}
              >
                <RotateCcw className={`h-3.5 w-3.5 ${retryQueue.isPending ? "animate-spin" : ""}`} />
                Retry queued leads
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={pruneLog.isPending}
                onClick={() => pruneLog.mutate()}
              >
                Prune error log
              </Button>

              {health?.recent_errors?.length ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() => setShowErrors((v) => !v)}
                  aria-expanded={showErrors}
                >
                  {health.recent_errors.length} recent error
                  {health.recent_errors.length === 1 ? "" : "s"}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${showErrors ? "rotate-180" : ""}`}
                  />
                </Button>
              ) : null}
            </div>

            {showErrors && health?.recent_errors?.length ? (
              <ul className="space-y-1.5 rounded-xl border border-border/60 bg-muted/30 p-3">
                {health.recent_errors.map((entry, idx) => (
                  <li
                    key={`${entry.occurred_at}-${idx}`}
                    className="flex flex-col gap-0.5 border-b border-border/40 pb-1.5 text-xs last:border-0 last:pb-0"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-border/50 text-[10px]">
                        {entry.action}
                      </Badge>
                      <span className="text-muted-foreground">
                        {new Date(entry.occurred_at).toLocaleString()}
                      </span>
                      {entry.lead_id ? (
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {entry.lead_id.slice(0, 8)}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-foreground/90">{entry.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-sm font-semibold ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}