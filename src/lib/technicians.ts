import { supabase } from "@/integrations/supabase/client";
import type { TechnicianRecord } from "@/components/technicians/TechnicianDialog";

export const TECHNICIAN_SELECT =
  "id, name, area, service, notes, chat_link, phone_number, latitude, longitude, code";
export const TECHNICIAN_FALLBACK_SELECT =
  "id, name, area, service, notes, chat_link, phone_number, latitude, longitude";

const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // hard safety cap = 50,000 rows

export async function fetchAllTechnicians(): Promise<TechnicianRecord[]> {
  const byId = new Map<string, TechnicianRecord>();
  let useFallback = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const selectCols = useFallback ? TECHNICIAN_FALLBACK_SELECT : TECHNICIAN_SELECT;
    let res = await supabase
      .from("technicians")
      .select(selectCols as any)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);

    if (res.error && (res.error.message?.includes("code") || (res.error as any).code === "42703")) {
      useFallback = true;
      res = await supabase
        .from("technicians")
        .select(TECHNICIAN_FALLBACK_SELECT as any)
        .order("name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }
    if (res.error) throw res.error;

    const rows = (res.data ?? []) as unknown as TechnicianRecord[];
    for (const r of rows) if (r?.id) byId.set(r.id, r);
    if (rows.length < PAGE_SIZE) break;
  }
  return Array.from(byId.values()).sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" }),
  );
}

// Shared React Query key for the full technician dataset (used by Map View).
export const TECHNICIANS_QUERY_KEY = ["technicians", "all"] as const;
// Root key covering every technician-related query (paginated, count, all).
export const TECHNICIANS_ROOT_KEY = ["technicians"] as const;

export function upsertTechnicianInList(
  list: TechnicianRecord[] | undefined,
  tech: TechnicianRecord,
): TechnicianRecord[] {
  const base = list ? list.filter((t) => t.id !== tech.id) : [];
  base.push(tech);
  return base.sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" }),
  );
}

export interface PaginatedTechnicians {
  technicians: TechnicianRecord[];
  totalCount: number;
}

export type TechnicianSortOption = "name_asc" | "name_desc" | "code_asc" | "code_desc" | "code_count";

/**
 * Database-backed paginated technician fetch with code filtering and sorting support.
 */
export async function fetchTechniciansPage(params: {
  page: number;
  pageSize: number;
  search: string;
  codeFilter?: string;
  sortBy?: TechnicianSortOption;
}): Promise<PaginatedTechnicians> {
  const page = Math.max(1, params.page | 0);
  const pageSize = Math.max(1, params.pageSize | 0);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const search = (params.search ?? "").trim();
  const codeFilter = (params.codeFilter ?? "all").trim();
  const sortBy = params.sortBy ?? "name_asc";

  if (search) {
    const { data, error } = await supabase.rpc("search_technicians", {
      _q: search,
      _limit: pageSize,
      _offset: from,
    });
    if (error) throw error;
    const rows = (data ?? []) as Array<TechnicianRecord & { total_count: number | string | null }>;
    const totalCount = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;

    // Attach codes if available
    let codeMap = new Map<string, string | null>();
    if (rows.length > 0) {
      try {
        const ids = rows.map((r) => r.id);
        const { data: codeData } = await supabase.from("technicians").select("id, code").in("id", ids);
        if (codeData) {
          codeMap = new Map(codeData.map((c) => [c.id, c.code]));
        }
      } catch {
        // ignore if code column missing
      }
    }

    let technicians: TechnicianRecord[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      area: r.area,
      service: r.service,
      notes: r.notes,
      chat_link: r.chat_link,
      phone_number: r.phone_number,
      latitude: r.latitude,
      longitude: r.longitude,
      code: codeMap.get(r.id) ?? (r as any).code ?? null,
    }));

    if (codeFilter !== "all") {
      if (codeFilter === "none") {
        technicians = technicians.filter((t) => !t.code);
      } else if (codeFilter === "has_code") {
        technicians = technicians.filter((t) => !!t.code);
      } else {
        technicians = technicians.filter((t) => t.code?.toLowerCase() === codeFilter.toLowerCase());
      }
    }

    return { technicians, totalCount: codeFilter !== "all" ? technicians.length : totalCount };
  }

  let query = supabase.from("technicians").select(TECHNICIAN_SELECT, { count: "exact" });

  if (codeFilter === "none") {
    query = query.is("code", null);
  } else if (codeFilter === "has_code") {
    query = query.not("code", "is", null);
  } else if (codeFilter && codeFilter !== "all") {
    query = query.eq("code", codeFilter);
  }

  if (sortBy === "name_desc") {
    query = query.order("name", { ascending: false }).order("id", { ascending: true });
  } else if (sortBy === "code_asc") {
    query = query.order("code", { ascending: true, nullsFirst: false }).order("name", { ascending: true });
  } else if (sortBy === "code_desc") {
    query = query.order("code", { ascending: false, nullsFirst: false }).order("name", { ascending: true });
  } else {
    // Default: name_asc
    query = query.order("name", { ascending: true }).order("id", { ascending: true });
  }

  query = query.range(from, to);

  let { data, error, count } = await query;

  if (error && (error.message?.includes("code") || (error as any).code === "42703")) {
    // Fallback if column not yet added
    let fbQuery = supabase
      .from("technicians")
      .select(TECHNICIAN_FALLBACK_SELECT, { count: "exact" })
      .order("name", { ascending: sortBy !== "name_desc" })
      .order("id", { ascending: true })
      .range(from, to);
    const fbRes = await fbQuery;
    if (fbRes.error) throw fbRes.error;
    data = fbRes.data as any;
    count = fbRes.count;
    error = null;
  }

  if (error) throw error;
  return {
    technicians: (data ?? []) as TechnicianRecord[],
    totalCount: count ?? 0,
  };
}
