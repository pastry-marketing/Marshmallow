import { supabase } from "@/integrations/supabase/client";

export interface LeadCoordinates {
  latitude: number;
  longitude: number;
  matchedAddress: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

const CACHE_LIMIT = 100;
const geocodeCache = new Map<string, LeadCoordinates | null>();

/** Resolve a US street address through the authenticated Census geocoder proxy. */
export async function geocodeLeadAddress(address: string | null | undefined): Promise<LeadCoordinates | null> {
  const normalized = address?.trim().replace(/\s+/g, " ") ?? "";
  if (normalized.length < 8) return null;

  const cacheKey = normalized.toLocaleLowerCase("en-US");
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey) ?? null;

  const { data, error } = await supabase.functions.invoke("geocode-lead-address", {
    body: { address: normalized },
  });
  if (error) throw new Error(error.message || "Address geocoding failed");

  const point = data?.match;
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
    remember(cacheKey, null);
    return null;
  }

  const result: LeadCoordinates = {
    latitude: point.latitude,
    longitude: point.longitude,
    matchedAddress: typeof point.matchedAddress === "string" ? point.matchedAddress : null,
    city: typeof point.city === "string" ? point.city : null,
    state: typeof point.state === "string" ? point.state : null,
    zip: typeof point.zip === "string" ? point.zip : null,
  };
  remember(cacheKey, result);
  return result;
}

function remember(key: string, value: LeadCoordinates | null) {
  if (geocodeCache.size >= CACHE_LIMIT) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest) geocodeCache.delete(oldest);
  }
  geocodeCache.set(key, value);
}
