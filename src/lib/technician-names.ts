/**
 * Job counts and Good Tech toggles are matched on the technician's name, so a
 * duplicated name silently merges several people. Hundreds of names in the
 * directory are shared by more than one technician, which makes a combined count
 * look authoritative when it is not.
 */
export type TechnicianNameCounts = Map<string, number>;

export function buildTechnicianNameCounts(technicians: Array<{ name?: string | null }>): TechnicianNameCounts {
  const counts: TechnicianNameCounts = new Map();
  for (const tech of technicians) {
    const key = tech.name?.trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function sharedNameCount(counts: TechnicianNameCounts | undefined, name: string | null | undefined) {
  const key = name?.trim().toLowerCase();
  return key && counts ? counts.get(key) ?? 0 : 0;
}