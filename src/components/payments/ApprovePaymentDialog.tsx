import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MapPin, TrendingUp } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

import {
  fetchAreaPerformance,
  formatAreaLabel,
  persistLeadLocation,
  resolveLeadLocation,
  setAreaOptimised,
  setGoodTechForLead,
  type ResolvedLocation,
} from "@/lib/area-optimization";

export interface ApprovePaymentTarget {
  leadId: string;
  customerName: string;
  amount: number;
  techName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
}

/**
 * Payment approval with an area decision attached.
 *
 * The point is that the tick is informed. Approving a payment is the moment
 * the job is known to have closed somewhere, so it is the moment worth asking
 * "is this a place we should be pushing more work into" - and the honest way
 * to answer is to show how that area has actually performed first, rather than
 * asking for a judgement call with no information behind it.
 *
 * Confirming the location here is also what stops the reports having to guess
 * forever: historical city/state is empty on nearly every lead, so each
 * approval that saves a corrected value turns an inferred place into a fact.
 */
export function ApprovePaymentDialog({
  target,
  onApprove,
  onOpenChange,
  open,
}: {
  target: ApprovePaymentTarget | null;
  onApprove: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [location, setLocation] = useState<ResolvedLocation>({ city: null, state: null, zip_code: null });
  const [optimised, setOptimised] = useState(false);
  const [goodTech, setGoodTech] = useState(false);

  // Reset per lead, otherwise approving one job leaves the previous job's area
  // and technician ticked on the next dialog.
  useEffect(() => {
    setOptimised(false);
    setGoodTech(false);
    setLocation({ city: target?.city ?? null, state: target?.state ?? null, zip_code: target?.zip_code ?? null });
  }, [target?.leadId, target?.city, target?.state, target?.zip_code]);

  const locationQuery = useQuery({
    queryKey: ["lead-location", target?.leadId],
    enabled: open && !!target,
    queryFn: () =>
      resolveLeadLocation({
        address: target?.address ?? null,
        city: target?.city ?? null,
        state: target?.state ?? null,
        zip_code: target?.zip_code ?? null,
      }),
  });

  const performanceQuery = useQuery({
    queryKey: ["area-performance", location.state, location.city, location.zip_code],
    enabled: open && !!location.state,
    queryFn: () => fetchAreaPerformance(location),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!target) return;

      // Best-effort side effects. The approval itself must not fail because an
      // area could not be marked or a technician could not be flagged - losing
      // the payment would be far worse than losing the annotation.
      try {
        await persistLeadLocation(target.leadId, location);
        if (location.state) await setAreaOptimised(location, optimised);
        await setGoodTechForLead(target.techName, goodTech);
      } catch (err) {
        toast.warning(
          `Payment approved, but the area note did not save: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["optimized-areas"] });
      queryClient.invalidateQueries({ queryKey: ["tech-performance"] });
      queryClient.invalidateQueries({ queryKey: ["area-performance"] });
    },
  });

  const handleConfirm = async () => {
    if (!target) return;
    await onApprove();
    await save.mutateAsync();
  };

  const perf = performanceQuery.data;
  const areaLabel = formatAreaLabel(location);
  const hasTech = !!(target?.techName ?? "").trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm payment approval</DialogTitle>
          <DialogDescription>
            This marks {target?.customerName || "this lead"} as paid for $
            {Number(target?.amount ?? 0).toFixed(2)}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="rounded-2xl border border-border/60 bg-background/60 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" />
              Where the job closed
            </div>

            {locationQuery.isPending ? (
              <Skeleton className="mt-3 h-9 w-full rounded-xl" />
            ) : (
              <>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Correct these if the address did not resolve properly. Saving them means the
                  reports stop having to infer this from the address text.
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="ap-city" className="text-[11px]">City</Label>
                    <Input
                      id="ap-city"
                      className="h-9 text-xs"
                      value={location.city ?? ""}
                      onChange={(e) => setLocation((p) => ({ ...p, city: e.target.value || null }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ap-state" className="text-[11px]">State</Label>
                    <Input
                      id="ap-state"
                      className="h-9 text-xs uppercase"
                      maxLength={2}
                      value={location.state ?? ""}
                      onChange={(e) =>
                        setLocation((p) => ({ ...p, state: e.target.value.toUpperCase() || null }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ap-zip" className="text-[11px]">ZIP</Label>
                    <Input
                      id="ap-zip"
                      className="h-9 text-xs"
                      value={location.zip_code ?? ""}
                      onChange={(e) => setLocation((p) => ({ ...p, zip_code: e.target.value || null }))}
                    />
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="rounded-2xl border border-border/60 bg-background/60 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              Should we push more work here?
            </div>

            {!location.state ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Add a state above to see how this area has performed.
              </p>
            ) : performanceQuery.isPending ? (
              <Skeleton className="mt-3 h-12 w-full rounded-xl" />
            ) : perf ? (
              <>
                <p className="mt-2 text-sm">
                  <span className="font-semibold text-foreground">{perf.paid_count}</span>{" "}
                  <span className="text-muted-foreground">jobs already closed in</span>{" "}
                  <span className="font-semibold text-foreground">{areaLabel || location.state}</span>
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {perf.cancelled_count} cancelled · {perf.scheduled_count} scheduled ·{" "}
                  {perf.technicians} technician{perf.technicians === 1 ? "" : "s"} ·{" "}
                  {perf.closed_rate_pct === null ? "no decided jobs yet" : `${perf.closed_rate_pct}% closed`}
                </p>
                <label className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2">
                  <span className="text-xs font-medium">Optimise {location.state}</span>
                  <Switch
                    checked={optimised}
                    onCheckedChange={setOptimised}
                    aria-label={`Mark ${location.state} as an area to optimise`}
                  />
                </label>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                No closed jobs recorded in this area yet.
              </p>
            )}
          </section>

          {hasTech ? (
            <section className="rounded-2xl border border-border/60 bg-background/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium">Good Tech</p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    Flag {target?.techName} on the Technicians page
                  </p>
                </div>
                <Switch
                  checked={goodTech}
                  onCheckedChange={setGoodTech}
                  aria-label={`Mark ${target?.techName} as a Good Tech`}
                />
              </div>
            </section>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Go back
          </Button>
          <Button onClick={handleConfirm} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Approve payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
