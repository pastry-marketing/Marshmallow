import { Badge } from "@/components/ui/badge";
import type { TechnicianRecord } from "@/components/technicians/TechnicianDialog";

import { sharedNameCount, type TechnicianNameCounts } from "@/lib/technician-names";

/** Flags a missing name, or a name shared with other technicians. */
export function TechnicianNameBadges({ tech, nameCounts }: { tech: Pick<TechnicianRecord, "name">; nameCounts?: Map<string, number> }) {
  const name = tech.name?.trim();
  const shared = sharedNameCount(nameCounts, name);
  if (name && shared <= 1) return null;
  return (
    <>
      {!name && <Badge variant="outline">No name</Badge>}
      {shared > 1 && (
        <Badge variant="outline" title={`${shared} technicians share this name, so job counts and name-based edits apply to all of them`}>
          {shared} with this name
        </Badge>
      )}
    </>
  );
}