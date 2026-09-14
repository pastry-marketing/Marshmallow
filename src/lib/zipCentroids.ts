// Local US ZIP code centroid dataset lookup.
// Dataset is loaded lazily (dynamic import) so the ~1.8MB JSON stays out of
// the initial JS bundle and is only fetched when Map View mounts.

export interface ZipCentroid {
  zip: string;
  latitude: number;
  longitude: number;
  city: string;
  state: string;
}

type ZipRow = [number, number, string, string]; // [lat, lng, city, state]
type ZipDataset = Record<string, ZipRow>;

let datasetPromise: Promise<ZipDataset> | null = null;

async function getDataset(): Promise<ZipDataset> {
  if (!datasetPromise) {
    datasetPromise = import("@/data/usZipCentroids.json").then(
      (m) => ((m as { default?: unknown }).default ?? m) as unknown as ZipDataset,
    );
  }
  return datasetPromise;
}

/**
 * Extract a valid 5-digit US ZIP code from arbitrary text.
 * - Accepts ZIP+4 (returns just the 5-digit prefix)
 * - Does NOT require whitespace between the state abbrev and ZIP (e.g. "CA94551")
 * - Preserves leading zeroes (values are treated as strings)
 * - Ignores 5-digit runs that are part of a longer number
 */
export function extractZip(value?: string | null): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // Match exactly 5 digits, optionally followed by -NNNN, not adjacent to more digits.
  const re = /(?<!\d)(\d{5})(?:-\d{4})?(?!\d)/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) matches.push(m[1]);
  if (matches.length === 0) return null;
  // Prefer the last match (typical trailing position in an address).
  const five = matches[matches.length - 1];
  return /^\d{5}$/.test(five) ? five : null;
}

/**
 * Resolve the best usable 5-digit ZIP for a lead.
 * Priority: explicit zip_code field → ZIP parsed from full address.
 * Returns both the chosen ZIP and where it came from (for diagnostics).
 */
export function resolveZipDetailed(input: {
  zip_code?: string | null;
  address?: string | null;
}): { zip: string | null; source: "zip_field" | "address" | "none"; storedZip: string | null; addressZip: string | null } {
  const storedZip = extractZip(input.zip_code);
  const addressZip = extractZip(input.address);
  if (storedZip) return { zip: storedZip, source: "zip_field", storedZip, addressZip };
  if (addressZip) return { zip: addressZip, source: "address", storedZip, addressZip };
  return { zip: null, source: "none", storedZip, addressZip };
}

export function resolveZip(input: {
  zip_code?: string | null;
  address?: string | null;
}): string | null {
  return resolveZipDetailed(input).zip;
}


/** Preload the dataset (e.g. call on mount to warm the cache). */
export async function preloadZipDataset(): Promise<void> {
  await getDataset();
}

/** Synchronous accessor once dataset is loaded. Returns null if not yet loaded. */
let cachedSync: ZipDataset | null = null;
getDataset().then((d) => { cachedSync = d; }).catch(() => {});

export function lookupZipCentroidSync(zip: string | null | undefined): ZipCentroid | null {
  if (!zip || !cachedSync) return null;
  const row = cachedSync[zip];
  if (!row) return null;
  return { zip, latitude: row[0], longitude: row[1], city: row[2], state: row[3] };
}

export async function lookupZipCentroid(zip: string | null | undefined): Promise<ZipCentroid | null> {
  if (!zip) return null;
  const ds = await getDataset();
  const row = ds[zip];
  if (!row) return null;
  return { zip, latitude: row[0], longitude: row[1], city: row[2], state: row[3] };
}

// ---------------------------------------------------------------------------
// City / state fallback: technician "area" is usually free text like
// "Miami, FL" with no ZIP, so ZIP lookup alone leaves most techs off the map.
// We derive a city-centre from the same dataset (average of a city's ZIP
// centroids) so any "City, ST" — or even a bare city — can still be placed.
// ---------------------------------------------------------------------------

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const VALID_STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));

let cityStateIndex: Map<string, { latitude: number; longitude: number }> | null = null;
let cityOnlyIndex: Map<string, { latitude: number; longitude: number }> | null = null;

function buildCityIndexes(ds: ZipDataset) {
  const cs = new Map<string, { lat: number; lng: number; n: number }>();
  const co = new Map<string, { lat: number; lng: number; n: number }>();
  for (const zip in ds) {
    const row = ds[zip];
    if (!row) continue;
    const lat = row[0];
    const lng = row[1];
    const city = String(row[2] ?? "").trim().toLowerCase();
    const state = String(row[3] ?? "").trim().toUpperCase();
    if (!city) continue;
    if (state) {
      const k = `${city}|${state}`;
      const a = cs.get(k);
      if (a) { a.lat += lat; a.lng += lng; a.n += 1; } else cs.set(k, { lat, lng, n: 1 });
    }
    const b = co.get(city);
    if (b) { b.lat += lat; b.lng += lng; b.n += 1; } else co.set(city, { lat, lng, n: 1 });
  }
  cityStateIndex = new Map();
  for (const [k, v] of cs) cityStateIndex.set(k, { latitude: v.lat / v.n, longitude: v.lng / v.n });
  cityOnlyIndex = new Map();
  for (const [k, v] of co) cityOnlyIndex.set(k, { latitude: v.lat / v.n, longitude: v.lng / v.n });
}

/** Parse a 2-letter state code from free-form area text (code or full name). */
function parseStateCode(text: string): string | null {
  const codeTokens = text.toUpperCase().match(/\b[A-Z]{2}\b/g);
  if (codeTokens) {
    for (let i = codeTokens.length - 1; i >= 0; i -= 1) {
      if (VALID_STATE_CODES.has(codeTokens[i])) return codeTokens[i];
    }
  }
  const lower = text.toLowerCase();
  for (const name in STATE_NAME_TO_CODE) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return STATE_NAME_TO_CODE[name];
  }
  return null;
}

/**
 * Resolve a centroid for arbitrary "area" text, synchronously (dataset must be
 * loaded). Tries, in order: an embedded ZIP, then City+State, then bare City.
 */
export function lookupAreaCentroidSync(area?: string | null): ZipCentroid | null {
  const zip = extractZip(area);
  if (zip) {
    const z = lookupZipCentroidSync(zip);
    if (z) return z;
  }
  if (!area || !cachedSync) return null;
  if (!cityStateIndex || !cityOnlyIndex) buildCityIndexes(cachedSync);

  const text = String(area).trim();
  if (!text) return null;
  const stateCode = parseStateCode(text);

  // City = the segment before the first comma, or the text with any trailing
  // state token stripped off.
  let city = text.includes(",") ? text.split(",")[0] : text;
  if (stateCode) {
    city = city
      .replace(new RegExp(`\\b${stateCode}\\b\\s*$`, "i"), "")
      .replace(/\b\d{5}(?:-\d{4})?\b\s*$/, "");
    const name = Object.keys(STATE_NAME_TO_CODE).find((n) => STATE_NAME_TO_CODE[n] === stateCode);
    if (name) city = city.replace(new RegExp(`\\b${name}\\b\\s*$`, "i"), "");
  }
  city = city.replace(/\b\d{5}(?:-\d{4})?\b/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!city) return null;

  if (stateCode) {
    const hit = cityStateIndex!.get(`${city}|${stateCode}`);
    if (hit) return { zip: "", latitude: hit.latitude, longitude: hit.longitude, city, state: stateCode };
  }
  const hitCity = cityOnlyIndex!.get(city);
  if (hitCity) return { zip: "", latitude: hitCity.latitude, longitude: hitCity.longitude, city, state: stateCode ?? "" };
  return null;
}
