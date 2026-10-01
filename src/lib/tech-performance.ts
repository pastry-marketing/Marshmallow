import { supabase } from "@/integrations/supabase/client";

/** One technician row as returned by public.tech_paid_performance(). */
export interface TechPerformanceRow {
  tech_name: string;
  paid_count: number;
  cancelled_count: number;
  scheduled_count: number;
  /** null when the technician has neither paid nor cancelled work. */
  paid_rate_pct: number | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  /** Always populated - falls back to state, then zip, then the raw address. */
  location_label: string;
  opr_code: string | null;
  good_tech: boolean;
  last_paid_at: string | null;
}

export interface TechPerformanceFilters {
  /** Inclusive lower bound, ISO timestamp. Null means no bound. */
  from?: string | null;
  /** Exclusive upper bound, ISO timestamp. Null means no bound. */
  to?: string | null;
}

/** Headline numbers shown above the table. */
export interface TechPerformanceSummary {
  technicians: number;
  paidTotal: number;
  cancelledTotal: number;
  scheduledTotal: number;
  /** paid / (paid + cancelled), as a percentage. Null when nothing to divide. */
  overallPaidRate: number | null;
  goodTechCount: number;
  /** Rows whose location came from the address rather than city/state. */
  approximateLocationCount: number;
}

export async function fetchTechPerformance(
  filters: TechPerformanceFilters = {},
): Promise<TechPerformanceRow[]> {
  const { data, error } = await supabase.rpc("tech_paid_performance" as never, {
    _from: filters.from ?? null,
    _to: filters.to ?? null,
  } as never);

  if (error) throw error;
  return (data as unknown as TechPerformanceRow[]) ?? [];
}

/**
 * Rolls the rows up into the headline figures.
 *
 * paid rate deliberately divides by paid + cancelled rather than by every lead.
 * Only leads that name a technician reached a point where a technician was
 * actually engaged, so leads with no technician must not sit in the denominator.
 * Leads that never got that far would otherwise drag the rate down for reasons
 * that have nothing to do with the technician.
 */
export function summariseTechPerformance(
  rows: TechPerformanceRow[],
): TechPerformanceSummary {
  let paidTotal = 0;
  let cancelledTotal = 0;
  let scheduledTotal = 0;
  let goodTechCount = 0;
  let approximateLocationCount = 0;

  for (const row of rows) {
    paidTotal += row.paid_count ?? 0;
    cancelledTotal += row.cancelled_count ?? 0;
    scheduledTotal += row.scheduled_count ?? 0;
    if (row.good_tech) goodTechCount += 1;
    // A state/zip fallback means the city could not be resolved, so the row is
    // grouped on a coarser location than the label suggests.
    if (!row.city && (row.state || row.zip_code)) approximateLocationCount += 1;
  }

  const decided = paidTotal + cancelledTotal;

  return {
    technicians: rows.length,
    paidTotal,
    cancelledTotal,
    scheduledTotal,
    overallPaidRate: decided > 0 ? round1((paidTotal / decided) * 100) : null,
    goodTechCount,
    approximateLocationCount,
  };
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Only the city when it is trustworthy, so grouping never mixes grains. */
export function areaGroupKey(row: TechPerformanceRow): string | null {
  if (row.state && row.zip_code) return `${row.state} ${row.zip_code}`;
  if (row.state) return row.state;
  if (row.zip_code) return row.zip_code;
  return null;
}

export interface AreaGroup {
  key: string;
  technicians: number;
  paid: number;
  cancelled: number;
  scheduled: number;
  paidRate: number | null;
}

/**
 * Groups technicians by state, then by zip when the state is known.
 *
 * Deliberately not grouped by parsed city: the address text is only reliably
 * parseable for the comma-delimited rows, so a city grouping would silently mix
 * real cities with whole street addresses and produce numbers that look
 * authoritative but are not.
 */
export function groupByArea(rows: TechPerformanceRow[]): AreaGroup[] {
  const map = new Map<string, AreaGroup>();

  for (const row of rows) {
    const key = areaGroupKey(row);
    if (!key) continue;

    const existing = map.get(key);
    if (existing) {
      existing.technicians += 1;
      existing.paid += row.paid_count ?? 0;
      existing.cancelled += row.cancelled_count ?? 0;
      existing.scheduled += row.scheduled_count ?? 0;
    } else {
      map.set(key, {
        key,
        technicians: 1,
        paid: row.paid_count ?? 0,
        cancelled: row.cancelled_count ?? 0,
        scheduled: row.scheduled_count ?? 0,
        paidRate: null,
      });
    }
  }

  const groups = [...map.values()];
  for (const group of groups) {
    const decided = group.paid + group.cancelled;
    group.paidRate = decided > 0 ? round1((group.paid / decided) * 100) : null;
  }

  return groups.sort((a, b) => {
    if (b.paid !== a.paid) return b.paid - a.paid;
    return a.key.localeCompare(b.key);
  });
}

/** RFC 4180 quoting, so a city or name containing a comma cannot break a row. */
export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function techPerformanceToCsv(rows: TechPerformanceRow[]): string {
  const header = [
    "Technician",
    "Location",
    "State",
    "ZIP",
    "Paid",
    "Cancelled",
    "Scheduled",
    "Paid rate %",
    "Good Tech",
    "OPR Code",
    "Last paid",
  ];

  const lines = rows.map((row) =>
    [
      row.tech_name,
      row.location_label,
      row.state ?? "",
      row.zip_code ?? "",
      row.paid_count,
      row.cancelled_count,
      row.scheduled_count,
      row.paid_rate_pct ?? "",
      row.good_tech ? "Yes" : "No",
      row.opr_code ?? "",
      row.last_paid_at ? row.last_paid_at.slice(0, 10) : "",
    ]
      .map(toCsvCell)
      .join(","),
  );

  return [header.join(","), ...lines].join("\r\n");
}
