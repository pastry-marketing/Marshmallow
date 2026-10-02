import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, MapPin, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchAreaPerformance,
  resolveLeadLocation,
  persistLeadLocation,
  setAreaOptimised,
  setGoodTechForLead,
  formatAreaLabel,
} from "@/lib/area-optimization";

interface InlineSuggestionsProps {
  leadId: string;
  techName: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  address: string | null;
  onDismissAll: () => void;
}

export function InlineSuggestions({
  leadId,
  techName,
  city,
  state,
  zip_code,
  address,
  onDismissAll,
}: InlineSuggestionsProps) {
  const queryClient = useQueryClient();
  const [techDismissed, setTechDismissed] = useState(false);
  const [areaDismissed, setAreaDismissed] = useState(false);
  const [techSaving, setTechSaving] = useState(false);
  const [areaSaving, setAreaSaving] = useState(false);

  const hasTech = !!(techName ?? "").trim();

  const techCountQuery = useQuery({
    queryKey: ["tech-closed-count", techName],
    enabled: hasTech && !techDismissed,
    queryFn: async () => {
      const name = (techName ?? "").trim();
      if (!name) return 0;
      const { count, error } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .ilike("tech_name", name)
        .eq("status", "paid");
      if (error) return 0;
      return count ?? 0;
    },
  });

  const locationQuery = useQuery({
    queryKey: ["suggestion-location", leadId],
    enabled: !areaDismissed,
    queryFn: () => resolveLeadLocation({ address, city, state, zip_code }),
  });

  const perfQuery = useQuery({
    queryKey: ["suggestion-area-perf", locationQuery.data?.state, locationQuery.data?.city],
    enabled: !areaDismissed && !!locationQuery.data?.state,
    queryFn: () => fetchAreaPerformance(locationQuery.data!),
  });

  const handleMarkGoodTech = async () => {
    setTechSaving(true);
    try {
      await setGoodTechForLead(techName, true);
      queryClient.invalidateQueries({ queryKey: ["tech-performance"] });
      toast.success(`${techName} marked as Good Tech`);
      setTechDismissed(true);
      if (areaDismissed || !locationQuery.data?.state) onDismissAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark tech");
    } finally {
      setTechSaving(false);
    }
  };

  const handleAddToOptimization = async () => {
    if (!locationQuery.data) return;
    setAreaSaving(true);
    try {
      await persistLeadLocation(leadId, locationQuery.data);
      await setAreaOptimised(locationQuery.data, true);
      queryClient.invalidateQueries({ queryKey: ["optimized-areas"] });
      queryClient.invalidateQueries({ queryKey: ["area-leaderboard"] });
      const label = formatAreaLabel(locationQuery.data);
      toast.success(`${label || locationQuery.data.state} added to optimization`);
      setAreaDismissed(true);
      if (techDismissed || !hasTech) onDismissAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add area");
    } finally {
      setAreaSaving(false);
    }
  };

  const dismissTech = () => {
    setTechDismissed(true);
    if (areaDismissed || !locationQuery.data?.state) onDismissAll();
  };

  const dismissArea = () => {
    setAreaDismissed(true);
    if (techDismissed || !hasTech) onDismissAll();
  };

  const showTech = hasTech && !techDismissed;
  const hasResolvedState = locationQuery.data?.state;
  const showArea = !areaDismissed && (hasResolvedState || locationQuery.isPending);

  if (!showTech && !showArea) return null;

  return (
    <div className="space-y-2">
      {showTech && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
          <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              Mark {techName} as Good Tech?
            </p>
            <p className="text-[12px] text-muted-foreground">
              {techCountQuery.isPending
                ? "Loading job count…"
                : `This tech has closed ${techCountQuery.data ?? 0} paid job${(techCountQuery.data ?? 0) === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-amber-500/30 text-xs hover:bg-amber-500/10"
              disabled={techSaving}
              onClick={handleMarkGoodTech}
            >
              {techSaving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Yes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground"
              onClick={dismissTech}
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {showArea && (
        <div className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/5 px-3 py-2.5">
          <MapPin className="h-4 w-4 shrink-0 text-blue-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              Add{" "}
              {locationQuery.data
                ? formatAreaLabel(locationQuery.data) || locationQuery.data.state
                : "this area"}{" "}
              to optimization?
            </p>
            <p className="text-[12px] text-muted-foreground">
              {locationQuery.isPending || perfQuery.isPending
                ? "Loading area data…"
                : perfQuery.data
                  ? `${perfQuery.data.paid_count} paid job${perfQuery.data.paid_count === 1 ? "" : "s"} in this area`
                  : "No paid jobs recorded in this area yet"}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-blue-500/30 text-xs hover:bg-blue-500/10"
              disabled={areaSaving || !locationQuery.data?.state}
              onClick={handleAddToOptimization}
            >
              {areaSaving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Yes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground"
              onClick={dismissArea}
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
