import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapPin, ArrowUpRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NEARBY_RADIUS_MILES, type ProximityLead } from "@/lib/lead-proximity";
import { openLeadFromClick } from "@/lib/lead-navigation";

interface Props {
  /** The other urgent leads near this one. Never rendered when empty. */
  nearby: ProximityLead[];
}

/**
 * Shown on an urgent lead whose area holds other urgent leads. Every lead in the cluster gets
 * this notice, listing the others - nearness is symmetric, so none of them is left out.
 */
export default function NearbyUrgentLeads({ nearby }: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  if (nearby.length === 0) return null;

  const label =
    nearby.length === 1
      ? "1 more urgent lead exists in this area"
      : `${nearby.length} more urgent leads exist in this area`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="mt-2 flex w-full items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/[0.09] px-2.5 py-1.5 text-left transition-colors hover:bg-red-500/[0.15]"
          title={`Other urgent leads within ${NEARBY_RADIUS_MILES} miles`}
        >
          <MapPin className="h-3 w-3 shrink-0 text-red-600 dark:text-red-400" />
          <span className="flex-1 truncate text-[11px] font-semibold leading-4 text-red-700 dark:text-red-300">
            {label}
          </span>
          <ArrowUpRight className="h-3 w-3 shrink-0 text-red-600/70 dark:text-red-400/70" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[320px] p-0" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border/40 px-3 py-2">
          <p className="text-[12px] font-semibold text-foreground">Urgent leads nearby</p>
          <p className="text-[11px] text-muted-foreground">
            Same city or within {NEARBY_RADIUS_MILES} miles
          </p>
        </div>

        <div className="max-h-[300px] divide-y divide-border/30 overflow-y-auto">
          {nearby.map((lead) => (
            <button
              key={lead.id}
              type="button"
              onClick={(event) => {
                setOpen(false);
                openLeadFromClick(event, lead.id, navigate);
              }}
              className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium text-foreground">
                  {lead.customer_name || lead.job_id || "Lead"}
                </span>
                {lead.address && (
                  <span className="block truncate text-[10.5px] text-muted-foreground">
                    {lead.address}
                  </span>
                )}
              </span>

              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                Open
                <ArrowUpRight className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
