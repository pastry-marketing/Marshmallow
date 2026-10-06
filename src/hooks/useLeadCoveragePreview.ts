import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { geocodeLeadAddress } from "@/lib/lead-address-geocoding";

export interface LeadCoveragePreviewResult {
  tech_count: number;
  area_label: string;
}

export type LeadCoveragePreviewState =
  | { status: "idle" | "checking" | "unresolved" | "error"; result: null }
  | { status: "ready"; result: LeadCoveragePreviewResult };

interface Options {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  enabled?: boolean;
}

/** Debounced preview using the same database calculation as a saved lead. */
export function useLeadCoveragePreview({
  address,
  city,
  state,
  zip,
  enabled = true,
}: Options): LeadCoveragePreviewState {
  const normalizedAddress = address?.trim() ?? "";
  const normalizedCity = city?.trim() || null;
  const normalizedState = state?.trim() || null;
  const normalizedZip = zip?.trim() || null;
  const [preview, setPreview] = useState<LeadCoveragePreviewState>({
    status: "idle",
    result: null,
  });

  useEffect(() => {
    if (!enabled || !normalizedAddress) {
      setPreview({ status: "idle", result: null });
      return;
    }

    let cancelled = false;
    setPreview({ status: "checking", result: null });

    const timer = window.setTimeout(async () => {
      let result: LeadCoveragePreviewResult | undefined;
      const point = await geocodeLeadAddress(normalizedAddress).catch((geocodeError) => {
        console.warn("Census address fallback failed:", geocodeError);
        return null;
      });
      if (cancelled) return;

      if (point) {
        const { data, error } = await supabase.rpc("preview_lead_technician_coverage_at_point", {
          _address: normalizedAddress,
          _city: point.city ?? normalizedCity,
          _state: point.state ?? normalizedState,
          _zip: point.zip ?? normalizedZip,
          _latitude: point.latitude,
          _longitude: point.longitude,
        });
        if (error) {
          console.warn("Located lead coverage preview failed:", error.message);
          setPreview({ status: "error", result: null });
          return;
        }
        result = data?.[0];
      } else {
        const { data, error } = await supabase.rpc("preview_lead_technician_coverage", {
          _address: normalizedAddress,
          _city: normalizedCity,
          _state: normalizedState,
          _zip: normalizedZip,
        });
        if (error) {
          console.warn("Lead coverage preview failed:", error.message);
          setPreview({ status: "error", result: null });
          return;
        }
        result = data?.[0];
      }

      if (cancelled) return;

      if (!result) {
        setPreview({ status: "unresolved", result: null });
        return;
      }

      setPreview({
        status: "ready",
        result: {
          tech_count: result.tech_count,
          area_label: result.area_label,
        },
      });
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, normalizedAddress, normalizedCity, normalizedState, normalizedZip]);

  return preview;
}
