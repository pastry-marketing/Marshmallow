export type GoogleAddress = {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  city: string | null;
  state: string | null;
  zip: string | null;
};
type GoogleComponent = { long_name: string; short_name: string; types: string[] };
type GoogleResult = {
  formatted_address?: string;
  partial_match?: boolean;
  types?: string[];
  address_components?: GoogleComponent[];
  geometry?: { location?: { lat: number; lng: number }; location_type?: string };
};

/** Never turn a city-only or partial match into a confirmed service address. */
export function parseGoogleAddress(result: GoogleResult | undefined): GoogleAddress | null {
  if (!result || result.partial_match || !result.formatted_address) return null;
  const components = result.address_components ?? [];
  const component = (type: string) => components.find((part) => part.types.includes(type));
  const point = result.geometry?.location;
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return null;
  if (component("country")?.short_name !== "US" || !component("street_number") || !component("route")) return null;
  if (!result.types?.some((type) => ["street_address", "premise", "subpremise"].includes(type))) return null;
  return {
    formattedAddress: result.formatted_address,
    latitude: point.lat, longitude: point.lng,
    city: component("locality")?.long_name ?? component("postal_town")?.long_name ?? null,
    state: component("administrative_area_level_1")?.short_name ?? null,
    zip: component("postal_code")?.long_name ?? null,
  };
}

const STATE_NAMES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
  illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
  maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
  pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd",
  tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
  "west virginia": "wv", wisconsin: "wi", wyoming: "wy", "district of columbia": "dc",
};

const ABBREVIATIONS: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln",
  court: "ct", place: "pl", highway: "hwy", parkway: "pkwy", terrace: "ter", circle: "cir",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw",
  southeast: "se", southwest: "sw", apartment: "apt", suite: "ste", building: "bldg",
};

/**
 * Formatting equivalence for address comparison. Google's standardized spelling
 * ("Street" for "st", "California" for "CA") is never treated as a different
 * location, and neither is a different country suffix or punctuation.
 */
export function addressComparisonKey(value: string): string {
  const lowered = value.toLowerCase()
    .replace(/\bunited states(?: of america)?\b|\bu\.?s\.?a\.?\b|\bus\b/g, " ")
    .replace(/\b\d+[a-z]?(?:\s+)([a-z]+)\b/g, (match, suffix: string) => `${match.slice(0, match.length - suffix.length)}${ABBREVIATIONS[suffix] ?? suffix}`);
  const words = lowered.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.map((word) => STATE_NAMES[word] ?? ABBREVIATIONS[word] ?? word).join("");
}

export function preserveAddressUnit(formatted: string, customerAddress: string): string {
  const unit = customerAddress.match(/\b(apt\.?|apartment|suite|ste\.?|unit|#)\s*([a-z0-9-]+)/i);
  if (!unit) return formatted;
  const label = unit[1].toLowerCase().replace(/\.$/, "");
  const rendered = label === "#" ? `#${unit[2]}` : `${label[0].toUpperCase()}${label.slice(1)} ${unit[2]}`;
  if (addressComparisonKey(formatted).includes(addressComparisonKey(rendered))) return formatted;
  // Google often omits secondary units; do not silently discard them.
  const commaIndex = formatted.indexOf(",");
  return commaIndex >= 0
    ? `${formatted.slice(0, commaIndex + 1)} ${rendered},${formatted.slice(commaIndex + 1)}`
    : `${formatted}, ${rendered}`;
}

export async function lookupGoogleAddress(address: string, apiKey: string | undefined): Promise<{ match: GoogleAddress | null; reason: string | null }> {
  if (!apiKey) return { match: null, reason: "google_not_configured" };
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("components", "country:US");
  url.searchParams.set("key", apiKey);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { match: null, reason: "google_unavailable" };
    const payload = await response.json() as { status?: string; results?: GoogleResult[] };
    if (payload.status !== "OK") return { match: null, reason: payload.status === "ZERO_RESULTS" ? "google_no_match" : "google_unavailable" };
    if (payload.results?.length !== 1) return { match: null, reason: "google_ambiguous" };
    const match = parseGoogleAddress(payload.results[0]);
    if (!match) return { match: null, reason: "google_incomplete_match" };
    match.formattedAddress = preserveAddressUnit(match.formattedAddress, address);
    return { match, reason: null };
  } catch {
    // Do not log request URLs: they contain the server-side API key.
    return { match: null, reason: "google_unavailable" };
  }
}
