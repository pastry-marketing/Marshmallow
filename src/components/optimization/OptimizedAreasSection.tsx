import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, MapPin, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";

import { supabase } from "@/integrations/supabase/client";
import {
  fetchAreaLeaderboard,
  fetchOptimizedAreas,
  setAreaOptimised,
  type OptimizedArea,
} from "@/lib/area-optimization";

function RateBadge({ rate }: { rate: number | null }) {
  if (rate === null) {
    return <span className="text-[12px] text-muted-foreground/50">&mdash;</span>;
  }
  return (
    <Badge
      variant="outline"
      className={
        rate >= 65
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
          : rate >= 45
            ? "border-border/60 bg-muted/40 text-foreground"
            : "border-destructive/30 bg-destructive/10 text-destructive"
      }
    >
      {rate}%
    </Badge>
  );
}

export function OptimizedAreasSection() {
  const queryClient = useQueryClient();
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);

  const boardQuery = useQuery({
    queryKey: ["area-leaderboard"],
    queryFn: () => fetchAreaLeaderboard(25),
  });

  const areasQuery = useQuery({
    queryKey: ["optimized-areas"],
    queryFn: fetchOptimizedAreas,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["optimized-areas"] });
    queryClient.invalidateQueries({ queryKey: ["area-leaderboard"] });
  };

  const remove = useMutation({
    mutationFn: async (area: OptimizedArea) => {
      const { error } = await supabase
        .from("optimized_areas" as never)
        .update({ is_active: false } as never)
        .eq("id", area.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Area unmarked");
    },
    onError: (err: Error) => toast.error(`Could not unmark the area: ${err.message}`),
  });

  const toggleFromBoard = useMutation({
    mutationFn: async ({ state, next }: { state: string; next: boolean }) => {
      await setAreaOptimised({ city: null, state, zip_code: null }, next);
    },
    onSuccess: (_d, vars) => {
      invalidate();
      toast.success(vars.next ? `${vars.state} is now an optimised area` : `${vars.state} unmarked`);
    },
    onError: (err: Error) => toast.error(`Could not update ${err.message}`),
  });

  const board = boardQuery.data ?? [];
  const areas = areasQuery.data ?? [];
  const marked = areas.filter((a) => a.is_active);
  const unmarked = areas.filter((a) => !a.is_active);

  return (
    <div className="space-y-5">
      {/* Primary: areas the admin is actively tracking */}
      <Card className="overflow-hidden border-border/60 bg-card/95">
        <CardContent className="p-0">
          <div className="flex flex-col gap-1 border-b border-border/50 bg-background/45 px-5 py-4">
            <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <MapPin className="h-4 w-4 text-primary" />
              Areas you are tracking
            </span>
            <span className="text-[12px] text-muted-foreground">
              Areas added through payment approval. Unmarking keeps the row, so the
              decision and its outcome are not lost.
            </span>
          </div>

          {areasQuery.isPending ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </div>
          ) : areasQuery.isError ? (
            <div className="p-10 text-center text-sm text-destructive">
              Could not load your marked areas.
            </div>
          ) : !areas.length ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              No areas marked yet. Approve a payment and use the suggestion to add an area here.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/20">
                  <tr className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                    <th scope="col" className="px-5 py-3 text-left font-semibold">Area</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Closed</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Cancelled</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Scheduled</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Techs</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Closed rate</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...marked, ...unmarked].map((area) => (
                    <tr
                      key={area.id}
                      className={`border-t border-border/40 ${area.is_active ? "" : "opacity-55"}`}
                    >
                      <td className="px-5 py-3">
                        <span className="font-medium text-foreground">{area.label}</span>
                        {area.is_active ? null : (
                          <span className="ml-2 text-[11px] text-muted-foreground">not tracked</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right font-semibold tabular-nums">{area.paid_count}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{area.cancelled_count}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{area.scheduled_count}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{area.technicians}</td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        <RateBadge rate={area.closed_rate_pct} />
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
                          disabled={remove.isPending || !area.is_active}
                          onClick={() => remove.mutate(area)}
                          aria-label={`Untrack ${area.label}`}
                          title={area.is_active ? "Untrack this area" : "Already untracked"}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Secondary: full area leaderboard, collapsed by default */}
      <Card className="overflow-hidden border-border/60 bg-card/95">
        <CardContent className="p-0">
          <button
            type="button"
            className="flex w-full items-center gap-2 border-b border-border/50 bg-background/45 px-5 py-4 text-left"
            onClick={() => setLeaderboardOpen((o) => !o)}
          >
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="flex-1 text-sm font-semibold text-foreground">
              All areas &mdash; where the work closes
            </span>
            {leaderboardOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {leaderboardOpen && (
            <>
              <p className="px-5 pt-3 text-[12px] text-muted-foreground">
                Areas ranked on the jobs that closed in them. Turn one on to start
                tracking it.
              </p>

              {boardQuery.isPending ? (
                <div className="space-y-2 p-5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 rounded-xl" />
                  ))}
                </div>
              ) : boardQuery.isError ? (
                <div className="space-y-2 p-10 text-center text-sm text-destructive">
                  <p>Could not load the area leaderboard.</p>
                  <p className="mt-2 text-[12px] opacity-80">
                    {(boardQuery.error as Error | null)?.message}
                  </p>
                </div>
              ) : !board.length ? (
                <div className="p-12 text-center text-sm text-muted-foreground">
                  No area could be resolved from any closed job yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/20">
                      <tr className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                        <th scope="col" className="px-5 py-3 text-left font-semibold">Area</th>
                        <th scope="col" className="px-5 py-3 text-right font-semibold">Closed</th>
                        <th scope="col" className="px-5 py-3 text-right font-semibold">Cancelled</th>
                        <th scope="col" className="px-5 py-3 text-right font-semibold">Scheduled</th>
                        <th scope="col" className="px-5 py-3 text-right font-semibold">Techs</th>
                        <th scope="col" className="px-5 py-3 text-right font-semibold">Closed rate</th>
                        <th scope="col" className="px-5 py-3 text-center font-semibold">Optimise</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.map((row) => (
                        <tr key={row.state} className="border-t border-border/40">
                          <td className="px-5 py-3">
                            <span className="font-medium text-foreground">{row.state}</span>
                            {row.cities ? (
                              <span
                                className="ml-2 text-[11px] text-muted-foreground"
                                title={row.cities}
                              >
                                {row.cities}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-5 py-3 text-right font-semibold tabular-nums">
                            {row.closed_count}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                            {row.cancelled_count}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                            {row.scheduled_count}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                            {row.technicians}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums">
                            <RateBadge rate={row.closed_rate_pct} />
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex justify-center">
                              <Switch
                                checked={row.is_optimised}
                                disabled={toggleFromBoard.isPending}
                                onCheckedChange={(next) =>
                                  toggleFromBoard.mutate({ state: row.state!, next })
                                }
                                aria-label={`Track ${row.state} as an optimised area`}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
