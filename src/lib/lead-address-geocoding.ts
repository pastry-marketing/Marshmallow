import { supabase } from "@/integrations/supabase/client";

export interface LeadCoordinates {
  latitude: number;
  longitude: number;
  matchedAddress: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  provider?: "google" | "census";
}

const CACHE_LIMIT = 100;
const geocodeCache = new Map<string, LeadCoordinates | null>();

/** Resolve a street address through Google, with an explicitly labelled Census fallback. */
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
    provider: point.provider === "google" ? "google" : "census",
  };
  remember(cacheKey, result);
  return result;
}

/** Resolve and persist location fields after a lead save without delaying the save itself. */
export async function geocodeAndPersistLeadAddress(
  leadId: string,
  address: string | null | undefined,
): Promise<boolean> {
  const addressToMatch = address ?? "";
  const normalized = addressToMatch.trim();
  if (!normalized) return false;

  try {
    const point = await geocodeLeadAddress(normalized);
    if (!point) return false;

    const { data, error } = await supabase
      .from("leads")
      .update({
        ...(point.provider === "google" && point.matchedAddress ? { address: point.matchedAddress } : {}),
        city: point.city,
        state: point.state,
        zip_code: point.zip,
        latitude: point.latitude,
        longitude: point.longitude,
      })
      .eq("id", leadId)
      // Do not let a slow geocode response overwrite a newer address edit.
      .eq("address", addressToMatch)
      .select("id")
      .maybeSingle();

    if (error) throw error;
    return Boolean(data);
  } catch (error) {
    console.warn("Background lead address geocoding failed:", error);
    return false;
  }
}

function remember(key: string, value: LeadCoordinates | null) {
  if (geocodeCache.size >= CACHE_LIMIT) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest) geocodeCache.delete(oldest);
  }
  geocodeCache.set(key, value);
}
