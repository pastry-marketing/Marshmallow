// PostgREST caps a single response at ~1000 rows. Any query that must return a
// whole (growing) table has to page through it, otherwise it silently drops
// everything past the first page — which is how status tabs/counts once
// undercounted leads. Route those "fetch the whole table" reads through this
// helper so the cap can never bite by accident.

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGES = 500; // hard safety cap = 500k rows

interface PageResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

/**
 * Page through a Supabase query in fixed-size chunks and return every row.
 *
 * `makeQuery(from, to)` must return a Supabase query already scoped to the
 * inclusive row range [from, to] (i.e. call `.range(from, to)` inside it), so a
 * fresh query is built per page. Ordering should be deterministic (e.g.
 * `.order("created_at").order("id")`) for stable pagination.
 *
 * @example
 * const leads = await fetchAllRows<Lead>((from, to) =>
 *   supabase.from("leads").select("*")
 *     .order("created_at", { ascending: false })
 *     .order("id", { ascending: false })
 *     .range(from, to),
 * );
 */
export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult>,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  const size = Math.max(1, pageSize | 0);
  const all: T[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * size;
    const { data, error } = await makeQuery(from, from + size - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < size) break;
  }

  return all;
}
