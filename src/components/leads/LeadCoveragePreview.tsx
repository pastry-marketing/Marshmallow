import { LoaderCircle, MapPin } from "lucide-react";
import { coverageLevelFor } from "@/lib/lead-coverage";
import { useLeadCoveragePreview } from "@/hooks/useLeadCoveragePreview";
import LeadCoverageBadge from "./LeadCoverageBadge";

interface Props {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  enabled?: boolean;
  className?: string;
}

/** Non-blocking live estimate shown while a user is entering a new job location. */
export default function LeadCoveragePreview({
  address,
  city,
  state,
  zip,
  enabled = true,
  className = "",
}: Props) {
  const preview = useLeadCoveragePreview({ address, city, state, zip, enabled });

  if (!enabled || !address?.trim()) return null;

  return (
    <div
      className={`flex min-h-7 flex-wrap items-center gap-2 text-[11px] text-muted-foreground ${className}`}
      aria-live="polite"
      aria-atomic="true"
    >
      {preview.status === "checking" && (
        <>
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>Checking technicians near this address…</span>
        </>
      )}
      {preview.status === "ready" && (
        <>
          <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="font-medium text-foreground/75">Coverage preview</span>
          <LeadCoverageBadge
            level={coverageLevelFor(preview.result.tech_count)}
            count={preview.result.tech_count}
            areaLabel={preview.result.area_label}
          />
          <span>within about 40 miles · updates after you finish typing</span>
        </>
      )}
      {preview.status === "unresolved" && (
        <span>
          Couldn’t place this address yet. Check the city and state, or choose a standardized address.
        </span>
      )}
      {preview.status === "error" && (
        <span>Coverage preview is temporarily unavailable; saving the lead will still work.</span>
      )}
    </div>
  );
}
