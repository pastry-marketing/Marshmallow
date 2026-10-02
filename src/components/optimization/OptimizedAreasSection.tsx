import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

import { supabase } from "@/integrations/supabase/client";
import { fetchOptimizedAreas, type OptimizedArea } from "@/lib/area-optimization";

function RateBadge({ rate }: { rate: number | null }) {
  if (rate === null) {
    return <span className="text-[12px] text-muted-foreground/50">—</span>;
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

/**
 * Areas an Admin has marked as worth optimising, with how each has actually
 * performed since.
 *
 * The counts are live rather than a snapshot, so marking an area is a decision
 * that keeps reporting on itself. Unmarking keeps the row and greys it out
 * rather than deleting it, so the history of what was tried is not lost.
 */
export function OptimizedAreasSection() {
  const queryClient = useQueryClient();

  const areasQuery = useQuery({
    queryKey: ["optimized-areas"],
    queryFn: fetchOptimizedAreas,
  });

  const remove = useMutation({
    mutationFn: async (area: OptimizedArea) => {
      // Deactivated rather than deleted: the row is the record of the decision.
      const { error } = await supabase
        .from("optimized_areas" as never)
        .update({ is_active: false } as never)
        .eq("id", area.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["optimized-areas"] });
      toast.success("Area unmarked");
    },
    onError: (err: Error) => toast.error(`Could not unmark the area: ${err.message}`),
  });

  const areas = areasQuery.data ?? [];
  const active = areas.filter((a) => a.is_active);
  const inactive = areas.filter((a) => !a.is_active);

  return (
    <Card className="overflow-hidden border-border/60 bg-card/95">
      <CardContent className="p-0">
        <div className="flex flex-col gap-1 border-b border-border/50 bg-background/45 px-5 py-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MapPin className="h-4 w-4 text-primary" />
            Optimised areas
          </span>
          <span className="text-[12px] text-muted-foreground">
            States you marked from payment approval, with the jobs that have closed in each
            since. Unmarking keeps the row so the decision is not lost.
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
            Could not load optimised areas. If the Optimised Areas migration has not been run
            yet, the <code>optimized_areas</code> table does not exist.
          </div>
        ) : !areas.length ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            No areas marked yet. Tick <strong>Optimise</strong> when approving a payment and it
            will appear here with its closed-job history.
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
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Technicians</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Closed rate</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...active, ...inactive].map((area) => (
                  <tr
                    key={area.id}
                    className={`border-t border-border/40 ${area.is_active ? "" : "opacity-55"}`}
                  >
                    <td className="px-5 py-3">
                      <span className="font-medium text-foreground">{area.label}</span>
                      {area.is_active ? null : (
                        <span className="ml-2 text-[11px] text-muted-foreground">not marked</span>
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
                        aria-label={`Unmark ${area.label} as an optimised area`}
                        title={area.is_active ? "Unmark this area" : "Already unmarked"}
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
  );
}