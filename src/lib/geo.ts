// Geographic helpers for Map View.

export const MILES_PER_KM = 0.621371;
export const EARTH_RADIUS_MI = 3958.7613;

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in miles between two coordinates (haversine). */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  const la = typeof lat === "number" ? lat : Number(lat);
  const ln = typeof lng === "number" ? lng : Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la === 0 && ln === 0) return false;
  return la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

const GEOCODE_CACHE_KEY = "marshmallow_geocode_cache_v1";

type CacheShape = Record<string, { lat: number; lng: number } | { failed: true; ts: number }>;

function readCache(): CacheShape {
  try {
    const raw = window.localStorage.getItem(GEOCODE_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as CacheShape;
  } catch {
    return {};
  }
}

function writeCache(cache: CacheShape) {
  try {
    window.localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore quota errors
  }
}

export function normalizeAddress(input: string): string {
  return input
    .replace(/\bnull\b/gi, "")
    .replace(/\bundefined\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/,+/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanPart(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return "";
  return s;
}

/** Clean address string: normalize whitespace, commas, and casing artifacts. */
export function cleanAddressLine(input: string): string {
  if (!input) return "";
  let s = String(input);
  // Insert missing commas between "STREETNAME<space>CITY" patterns is hard;
  // instead just collapse noise.
  s = s
    .replace(/\bnull\b/gi, "")
    .replace(/\bundefined\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,+/g, ",")
    .replace(/,\s*,/g, ", ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
  return s;
}

/** Remove secondary unit designators (APT, UNIT, SUITE, STE, #N) while keeping the street number. */
export function stripUnit(input: string): string {
  if (!input) return "";
  let s = " " + input + " ";
  // Full-word patterns with optional # and number/letter
  s = s.replace(/\s(?:APT|APARTMENT|UNIT|SUITE|STE|BLDG|BUILDING|LOT|RM|ROOM|FL|FLOOR|TRLR|TRAILER)\.?\s*#?\s*[A-Z0-9-]+/gi, " ");
  // Standalone "# 5" or "#5" tokens that are NOT the leading street number
  // Only strip when preceded by whitespace and something else (not start-of-string)
  s = s.replace(/(\S)\s+#\s*[A-Z0-9-]+/gi, "$1");
  return cleanAddressLine(s);
}

/** Build a prioritized list of geocoding queries from lead-like location fields. */
export function buildGeocodeQueries(input: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string[] {
  const rawAddress = cleanPart(input.address);
  const address = cleanAddressLine(rawAddress);
  const addressNoUnit = stripUnit(address);
  const city = cleanPart(input.city);
  const state = cleanPart(input.state);
  const zip = cleanPart(input.zip);

  const join = (...parts: string[]) =>
    parts.filter(Boolean).join(", ").replace(/,\s*,/g, ", ").trim();

  const candidates: string[] = [];
  // A. Full normalized
  if (address && city && state && zip) candidates.push(join(address, city, state, zip, "USA"));
  if (address && city && state) candidates.push(join(address, city, state, "USA"));
  // B. Without unit
  if (addressNoUnit && addressNoUnit !== address && city && state && zip) candidates.push(join(addressNoUnit, city, state, zip, "USA"));
  if (addressNoUnit && addressNoUnit !== address && city && state) candidates.push(join(addressNoUnit, city, state, "USA"));
  if (address && zip) candidates.push(join(address, zip, "USA"));
  if (addressNoUnit && addressNoUnit !== address && zip) candidates.push(join(addressNoUnit, zip, "USA"));
  // D. Street + City + State (no zip)
  if (addressNoUnit && city && state) candidates.push(join(addressNoUnit, city, state, "USA"));
  // E. City + State + ZIP
  if (city && state && zip) candidates.push(join(city, state, zip, "USA"));
  // F. City + State
  if (city && state) candidates.push(join(city, state, "USA"));
  // G. ZIP only
  if (zip) candidates.push(join(zip, "USA"));
  if (address && !city && !state && !zip) candidates.push(join(address, "USA"));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const key = normalizeAddress(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Place types that represent an *area* (draw a boundary) rather than a single
// point (drop a marker).
const AREA_ADDRESS_TYPES = new Set([
  "city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter",
  "state", "region", "province", "county", "municipality", "district",
  "postcode", "administrative", "borough", "city_district", "locality", "island",
]);

export interface AreaGeocodeResult {
  latitude: number;
  longitude: number;
  /** [south, north, west, east] in degrees, when Nominatim provides it. */
  boundingBox: [number, number, number, number] | null;
  /** Polygon / MultiPolygon geometry for the area outline, when available. */
  geojson: unknown | null;
  /** true → draw an area boundary; false → drop a pinpoint marker. */
  isArea: boolean;
  displayName: string;
}

/**
 * Geocode a free-form place query for Map View search. Returns the point plus,
 * for areas (city / ZIP / county / …), a boundary outline and bounding box so
 * the caller can draw the region; a specific address resolves to a point.
 */
export async function geocodeArea(query: string): Promise<AreaGeocodeResult | null> {
  const q = query.trim();
  if (!q) return null;
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us` +
    `&polygon_geojson=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`geocode http ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = data[0] as {
    lat: string; lon: string; boundingbox?: string[]; geojson?: { type?: string };
    addresstype?: string; type?: string; class?: string; category?: string; display_name?: string;
  };
  const lat = parseFloat(r.lat);
  const lng = parseFloat(r.lon);
  if (!isValidLatLng(lat, lng)) return null;

  const boundingBox = Array.isArray(r.boundingbox) && r.boundingbox.length === 4
    ? [parseFloat(r.boundingbox[0]), parseFloat(r.boundingbox[1]), parseFloat(r.boundingbox[2]), parseFloat(r.boundingbox[3])] as [number, number, number, number]
    : null;

  const geoType = r.geojson?.type;
  const geojson = geoType === "Polygon" || geoType === "MultiPolygon" ? r.geojson : null;

  const addressType = String(r.addresstype ?? r.type ?? "").toLowerCase();
  const category = String(r.class ?? r.category ?? "").toLowerCase();
  const isArea = Boolean(geojson) || category === "boundary" || AREA_ADDRESS_TYPES.has(addressType);

  return { latitude: lat, longitude: lng, boundingBox, geojson, isArea, displayName: String(r.display_name ?? q) };
}

async function nominatimQuery(query: string): Promise<LatLng | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`geocode http ${res.status}`);
  const data: Array<{ lat: string; lon: string }> = await res.json();
  if (!data.length) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!isValidLatLng(lat, lng)) return null;
  return { latitude: lat, longitude: lng };
}

/** Structured Nominatim query — never combined with free-form q. */
async function nominatimStructured(input: {
  street?: string;
  city?: string;
  state?: string;
  postalcode?: string;
}): Promise<LatLng | null> {
  const params = new URLSearchParams({ format: "json", limit: "1", country: "United States" });
  if (input.street) params.set("street", input.street);
  if (input.city) params.set("city", input.city);
  if (input.state) params.set("state", input.state);
  if (input.postalcode) params.set("postalcode", input.postalcode);
  // Require at least one structured field
  if (!input.street && !input.city && !input.postalcode) return null;
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`geocode http ${res.status}`);
  const data: Array<{ lat: string; lon: string }> = await res.json();
  if (!data.length) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!isValidLatLng(lat, lng)) return null;
  return { latitude: lat, longitude: lng };
}

/** U.S. Census geocoder — public, no API key. Returns coords or null. */
async function censusOneLine(query: string): Promise<LatLng | null> {
  const url =
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` +
    `?address=${encodeURIComponent(query)}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`census http ${res.status}`);
  const data = await res.json();
  const matches = data?.result?.addressMatches;
  if (!Array.isArray(matches) || !matches.length) return null;
  const c = matches[0]?.coordinates;
  const lat = Number(c?.y);
  const lng = Number(c?.x);
  if (!isValidLatLng(lat, lng)) return null;
  return { latitude: lat, longitude: lng };
}

async function censusStructured(input: {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}): Promise<LatLng | null> {
  if (!input.street) return null;
  const params = new URLSearchParams({
    street: input.street,
    benchmark: "Public_AR_Current",
    format: "json",
  });
  if (input.city) params.set("city", input.city);
  if (input.state) params.set("state", input.state);
  if (input.zip) params.set("zip", input.zip);
  const url = `https://geocoding.geo.census.gov/geocoder/locations/address?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`census http ${res.status}`);
  const data = await res.json();
  const matches = data?.result?.addressMatches;
  if (!Array.isArray(matches) || !matches.length) return null;
  const c = matches[0]?.coordinates;
  const lat = Number(c?.y);
  const lng = Number(c?.x);
  if (!isValidLatLng(lat, lng)) return null;
  return { latitude: lat, longitude: lng };
}

/** Geocode a single free-form address; cached in localStorage. */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const key = normalizeAddress(address);
  if (!key) return null;
  const cache = readCache();
  const entry = cache[key];
  if (entry) {
    if ("failed" in entry) {
      if (Date.now() - entry.ts < 24 * 3600 * 1000) return null;
    } else {
      return { latitude: entry.lat, longitude: entry.lng };
    }
  }

  try {
    const result = await nominatimQuery(address);
    if (!result) {
      cache[key] = { failed: true, ts: Date.now() };
      writeCache(cache);
      return null;
    }
    cache[key] = { lat: result.latitude, lng: result.longitude };
    writeCache(cache);
    return result;
  } catch {
    // transient error — don't poison cache
    return null;
  }
}

export type GeocodeFailReason =
  | "no_result"
  | "nominatim_no_result"
  | "census_no_result"
  | "request_failed"
  | "no_input";

export type GeocodeProvider = "nominatim_freeform" | "nominatim_structured" | "census_oneline" | "census_structured";

export interface GeocodeAttemptResult {
  coords: LatLng | null;
  query: string | null;
  reason: GeocodeFailReason | null;
  provider?: GeocodeProvider;
}

/**
 * Clear negative-cache entries so retries force a fresh provider request.
 * Successful coordinate entries are preserved.
 */
export function clearNegativeCacheFor(input: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): void {
  const queries = buildGeocodeQueries(input);
  if (!queries.length) return;
  const cache = readCache();
  let changed = false;
  for (const q of queries) {
    const key = normalizeAddress(q);
    const entry = cache[key];
    if (entry && "failed" in entry) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) writeCache(cache);
}

async function pause(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Geocode with progressive fallback across Nominatim (freeform + structured) then Census. */
export async function geocodeWithFallback(input: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): Promise<GeocodeAttemptResult> {
  const queries = buildGeocodeQueries(input);
  if (!queries.length) return { coords: null, query: null, reason: "no_input" };

  const rawAddress = cleanPart(input.address);
  const address = cleanAddressLine(rawAddress);
  const addressNoUnit = stripUnit(address);
  const city = cleanPart(input.city);
  const state = cleanPart(input.state);
  const zip = cleanPart(input.zip);

  let sawRequestFailure = false;

  // --- Phase 1: Nominatim free-form queries (with negative cache) ---
  for (const q of queries) {
    const key = normalizeAddress(q);
    const cache = readCache();
    const hit = cache[key];
    if (hit && !("failed" in hit)) {
      return { coords: { latitude: hit.lat, longitude: hit.lng }, query: q, reason: null, provider: "nominatim_freeform" };
    }
    if (hit && "failed" in hit && Date.now() - hit.ts < 24 * 3600 * 1000) {
      continue;
    }
    try {
      const res = await nominatimQuery(q);
      if (res) {
        const fresh = readCache();
        fresh[key] = { lat: res.latitude, lng: res.longitude };
        writeCache(fresh);
        return { coords: res, query: q, reason: null, provider: "nominatim_freeform" };
      }
      const fresh = readCache();
      fresh[key] = { failed: true, ts: Date.now() };
      writeCache(fresh);
    } catch {
      sawRequestFailure = true;
    }
    await pause(1100);
  }

  // --- Phase 2: Nominatim structured ---
  try {
    const streetForStructured = addressNoUnit || address;
    if (streetForStructured || (city && state) || zip) {
      const res = await nominatimStructured({
        street: streetForStructured || undefined,
        city: city || undefined,
        state: state || undefined,
        postalcode: zip || undefined,
      });
      if (res) {
        return {
          coords: res,
          query: `structured:${streetForStructured} / ${city} / ${state} / ${zip}`,
          reason: null,
          provider: "nominatim_structured",
        };
      }
    }
  } catch {
    sawRequestFailure = true;
  }
  await pause(1100);

  // --- Phase 3: Census one-line ---
  const censusOneLineQuery = [addressNoUnit || address, city, state, zip].filter(Boolean).join(", ");
  if (censusOneLineQuery) {
    try {
      const res = await censusOneLine(censusOneLineQuery);
      if (res) {
        return { coords: res, query: censusOneLineQuery, reason: null, provider: "census_oneline" };
      }
    } catch {
      sawRequestFailure = true;
    }
  }

  // --- Phase 4: Census structured ---
  if (addressNoUnit || address) {
    try {
      const res = await censusStructured({
        street: addressNoUnit || address,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined,
      });
      if (res) {
        return {
          coords: res,
          query: `census-structured:${addressNoUnit || address} / ${city} / ${state} / ${zip}`,
          reason: null,
          provider: "census_structured",
        };
      }
    } catch {
      sawRequestFailure = true;
    }
  }

  if (sawRequestFailure) {
    return { coords: null, query: null, reason: "request_failed" };
  }
  return { coords: null, query: null, reason: "no_result" };
}
