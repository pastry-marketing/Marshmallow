import { preserveAddressUnit } from "./google-address.ts";

export type CensusAddress = {
  latitude: number;
  longitude: number;
  matchedAddress: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  provider: "census";
};

/** A map point must be a unique Census match, never a Google/unknown fallback. */
export function parseCensusAddress(payload: unknown, address: string): CensusAddress | null {
  const data = payload as { result?: { addressMatches?: Array<{
    matchedAddress?: unknown; coordinates?: { x?: unknown; y?: unknown };
    addressComponents?: { city?: unknown; state?: unknown; zip?: unknown };
  }> } } | null;
  const matches = data?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length !== 1) return null;
  const match = matches[0];
  if (!match || typeof match !== "object") return null;
  const coordinate = (value: unknown) => typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  const latitude = coordinate(match.coordinates?.y);
  const longitude = coordinate(match.coordinates?.x);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0) || typeof match.matchedAddress !== "string" || !match.matchedAddress.trim()) return null;
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    latitude, longitude, provider: "census",
    matchedAddress: preserveAddressUnit(match.matchedAddress.trim(), address),
    city: text(match.addressComponents?.city), state: text(match.addressComponents?.state)?.toUpperCase() ?? null,
    zip: text(match.addressComponents?.zip),
  };
}

export async function lookupCensusAddress(address: string, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<CensusAddress | null> {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const timeout = AbortSignal.timeout(8000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetcher ?? fetch)(url, { signal });
  if (!response.ok) throw new Error(`Census address lookup returned HTTP ${response.status}`);
  return parseCensusAddress(await response.json(), address);
}
