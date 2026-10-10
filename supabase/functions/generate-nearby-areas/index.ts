// Non-AI: geocode customer address, then look up top-5 populated places within
// 50 miles via public.get_top_nearby_populated_areas.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { lookupCensusAddress, type CensusAddress } from "../_shared/census-address.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function log(stage: string, data: Record<string, unknown> = {}) {
  try {
    console.log(JSON.stringify({ fn: "generate-nearby-areas", stage, ...data }));
  } catch {
    console.log(`[generate-nearby-areas] ${stage}`);
  }
}

const STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const STATE_CODES = new Set(Object.values(STATE_ABBR));

const STREET_SUFFIX_RE =
  /\b(?:aly|alley|ave|avenue|blvd|boulevard|cir|circle|ct|court|dr|drive|hwy|highway|ln|lane|loop|pkwy|parkway|pl|place|rd|road|st|street|ter|terrace|trl|trail|way)\.?\b/i;

function normalizeStateToken(s: string): string {
  const lower = s.trim().toLowerCase();
  return STATE_ABBR[lower] ?? s.trim().toUpperCase();
}

function normalizeZipToken(s: string): string {
  const match = s.match(/\b(?:[A-Z]{2}\s*)?(\d{5})(?:-\d{4})?\b/i);
  return match?.[1] ?? "";
}

function normalizeAddress(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/,+/g, ",").replace(/\s*,\s*/g, ", ");
  for (const [full, abbr] of Object.entries(STATE_ABBR)) {
    const re = new RegExp(`\\b${full}\\b`, "gi");
    s = s.replace(re, abbr);
  }
  return s.replace(/^[,\s]+|[,\s]+$/g, "");
}

function extractZipAndState(raw: string): { zip: string; state: string; matchText: string } {
  // Use negative lookahead to match the LAST 5-digit number, avoiding house numbers like 11009.
  const match = raw.match(/\b([A-Z]{2})?\s*(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/i);
  const possibleState = match?.[1]?.toUpperCase() ?? "";
  return {
    zip: match?.[2] ?? "",
    state: STATE_CODES.has(possibleState) ? possibleState : "",
    matchText: match?.[0] ?? "",
  };
}

function inferInlineAddressParts(raw: string): { street: string; city: string; state: string; zip: string } {
  const normalized = normalizeAddress(raw);
  const zipInfo = extractZipAndState(normalized);
  let state = zipInfo.state;
  let withoutZip = normalized;
  if (zipInfo.matchText) withoutZip = withoutZip.replace(zipInfo.matchText, " ");
  if (!state) {
    const stateAtEnd = withoutZip.match(/(?:^|[\s,])([A-Z]{2})(?:[\s,]*$)/i);
    const possibleState = stateAtEnd?.[1]?.toUpperCase() ?? "";
    if (STATE_CODES.has(possibleState)) state = possibleState;
  }
  if (state) {
    withoutZip = withoutZip.replace(new RegExp(`(?:^|[\\s,])${state}(?:[\\s,]*$)`, "i"), " ");
  }
  const locationText = withoutZip.replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "");
  if (!locationText) return { street: "", city: "", state, zip: zipInfo.zip };
  const commaParts = locationText.split(",").map((p) => p.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const city = commaParts[commaParts.length - 1];
    const street = commaParts.slice(0, -1).join(", ");
    return { street, city, state, zip: zipInfo.zip };
  }
  const suffixMatch = STREET_SUFFIX_RE.exec(locationText);
  if (suffixMatch?.index !== undefined) {
    const suffixEnd = suffixMatch.index + suffixMatch[0].length;
    const street = locationText.slice(0, suffixEnd).trim();
    const city = locationText.slice(suffixEnd).trim();
    return { street, city, state, zip: zipInfo.zip };
  }
  return { street: "", city: locationText, state, zip: zipInfo.zip };
}

function separateBusinessName(raw: string): { placeName: string | null; addr: string } {
  const m = raw.match(/^(.*?)\s(\d+\s+[A-Za-z0-9].*)$/);
  if (m) {
    const before = m[1].trim();
    const rest = m[2].trim();
    if (before && !/^\d/.test(before) && before.split(/\s+/).length >= 2) {
      return { placeName: before, addr: rest };
    }
  }
  return { placeName: null, addr: raw };
}

async function nominatimFree(q: string, signal: AbortSignal) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&addressdetails=0&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { signal, headers: { "User-Agent": "MarshmallowCRM/1.0 (nearby-areas)" } });
  if (!r.ok) return null;
  const data = (await r.json()) as Array<{ lat: string; lon: string; display_name?: string }>;
  if (!data?.length) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, matched: data[0].display_name ?? q };
}

async function nominatimStructured(
  parts: { street?: string; city?: string; state?: string; postalcode?: string },
  signal: AbortSignal,
) {
  const params = new URLSearchParams();
  params.set("format", "json");
  params.set("limit", "1");
  params.set("countrycodes", "us");
  if (parts.street) params.set("street", parts.street);
  if (parts.city) params.set("city", parts.city);
  if (parts.state) params.set("state", parts.state);
  if (parts.postalcode) params.set("postalcode", parts.postalcode);
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const r = await fetch(url, { signal, headers: { "User-Agent": "MarshmallowCRM/1.0 (nearby-areas)" } });
  if (!r.ok) return null;
  const data = (await r.json()) as Array<{ lat: string; lon: string; display_name?: string }>;
  if (!data?.length) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, matched: data[0].display_name ?? "" };
}

async function zipCentroid(zip: string, signal: AbortSignal) {
  const cleanZip = normalizeZipToken(zip);
  if (!cleanZip) return null;
  const url = `https://api.zippopotam.us/us/${encodeURIComponent(cleanZip)}`;
  const r = await fetch(url, { signal, headers: { "User-Agent": "MarshmallowCRM/1.0 (nearby-areas)" } });
  if (!r.ok) return null;
  const data = (await r.json()) as { places?: Array<{ latitude: string; longitude: string; "place name"?: string; state?: string; "state abbreviation"?: string }> };
  const place = data.places?.[0];
  if (!place) return null;
  const lat = parseFloat(place.latitude);
  const lng = parseFloat(place.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const matched = [place["place name"], place["state abbreviation"] || place.state, cleanZip].filter(Boolean).join(", ");
  return { lat, lng, matched };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED", message: "Method not allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return json({ code: "UNAUTHORIZED", message: "Unauthorized" }, 401);
    }
    const { data: userRes, error: userErr } = await admin.auth.getUser(auth.slice(7));
    if (userErr || !userRes.user) {
      return json({ code: "UNAUTHORIZED", message: "Unauthorized" }, 401);
    }
    const userId = userRes.user.id;
    log("auth_ok", { userId });

    const { data: roleRow } = await admin
      .from("user_roles").select("role").eq("user_id", userId).maybeSingle();
    const role = roleRow?.role;
    if (role !== "admin" && role !== "processor") {
      return json({ code: "FORBIDDEN", message: "Forbidden" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const leadId = String(body.leadId ?? "");
    if (!leadId) return json({ code: "BAD_REQUEST", message: "leadId is required" }, 400);

    const { data: lead, error: leadErr } = await admin
      .from("leads")
      .select("id, address, half_address, city, state, zip_code, latitude, longitude")
      .eq("id", leadId)
      .maybeSingle();
    if (leadErr) {
      log("lead_fetch_failed", { code: leadErr.code, message: leadErr.message });
      return json({ code: "LEAD_QUERY_FAILED", message: "Failed to load lead." }, 500);
    }
    if (!lead) return json({ code: "LEAD_NOT_FOUND", message: "Lead not found" }, 404);
    log("lead_loaded", { leadId });

    // Use frontend-provided address fields if available (so we can geocode unsaved changes),
    // otherwise fall back to the database fields.
    const rawAddress = (body.customerAddress !== undefined ? body.customerAddress : (lead.address ?? lead.half_address)) || "";
    const rawCity = (body.customerCity !== undefined ? body.customerCity : lead.city) || "";
    const rawState = (body.customerState !== undefined ? body.customerState : lead.state) || "";
    const rawZip = (body.customerZip !== undefined ? body.customerZip : lead.zip_code) || "";
    const savedLocation = ([
      ["customerAddress", lead.address ?? lead.half_address], ["customerCity", lead.city],
      ["customerState", lead.state], ["customerZip", lead.zip_code],
    ] as const).every(([key, value]) => body[key] === undefined ||
      String(body[key] ?? "").trim().toLowerCase() === String(value ?? "").trim().toLowerCase());

    const { placeName, addr } = separateBusinessName(rawAddress.trim());
    const inferred = inferInlineAddressParts(addr);
    const city = normalizeAddress(rawCity.trim()).replace(/,$/, "").trim() || inferred.city;
    const state = rawState.trim() ? normalizeStateToken(rawState.trim()) : inferred.state;
    const zip = normalizeZipToken(rawZip.trim()) || inferred.zip;
    let lat: number | null =
      typeof lead.latitude === "number" && Number.isFinite(lead.latitude) ? lead.latitude : null;
    let lng: number | null =
      typeof lead.longitude === "number" && Number.isFinite(lead.longitude) ? lead.longitude : null;
    if (lat !== null && (lat < -90 || lat > 90 || (lat === 0 && lng === 0))) lat = null;
    if (lng !== null && (lng < -180 || lng > 180)) lng = null;

    const normalizedAddress = normalizeAddress(addr);
    const streetAddress = inferred.street ? normalizeAddress(inferred.street) : normalizedAddress;
    const addressHasInlineLocation = Boolean(inferred.zip || inferred.state || inferred.city);
    const parts = addressHasInlineLocation
      ? normalizedAddress
      : [normalizedAddress, city, state, zip].filter(Boolean).join(", ");
    const sourceAddress = parts || (lat !== null && lng !== null ? `${lat},${lng}` : "");

    const hasCoords = lat !== null && lng !== null;
    const hasEnough = hasCoords || (city && state) || zip || normalizedAddress;
    if (!hasEnough) {
      return json(
        { code: "LOCATION_MISSING", message: "Add a valid customer address, city and state, ZIP code, or coordinates before finding nearby areas." },
        400,
      );
    }
    log("location_inputs", { hasCoords, hasCity: !!city, hasState: !!state, hasZip: !!zip, hasAddr: !!normalizedAddress });

    let matched = "";
    let accuracy: "coordinates" | "address" | "street_zip" | "city_state" | "zip_centroid" | "unknown" = "unknown";
    let censusPoint: CensusAddress | null = null;

    // Always re-geocode from the current address to avoid stale stored coords.
    // Only fall back to stored coords if every geocoding attempt fails.
    const storedLat = lat;
    const storedLng = lng;
    lat = null;
    lng = null;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    try {
      if (normalizedAddress) {
        try {
          censusPoint = await lookupCensusAddress(parts, { signal: controller.signal });
          if (censusPoint) { lat = censusPoint.latitude; lng = censusPoint.longitude; matched = censusPoint.matchedAddress; accuracy = "address"; }
        } catch (error) {
          log("census_lookup_unavailable", { message: error instanceof Error ? error.message : String(error) });
        }
      }
      const expectedStateCode = state.toUpperCase();
      const expectedFullState = Object.keys(STATE_ABBR).find(k => STATE_ABBR[k] === expectedStateCode) || "";
      
      const isValidMatch = (displayName: string) => {
        if (!displayName) return true;
        const lower = displayName.toLowerCase();
        
        let hasZip = false;
        let hasState = false;
        
        if (zip && lower.includes(zip)) hasZip = true;
        
        if (expectedStateCode) {
            const reAbbr = new RegExp(`\\b${expectedStateCode.toLowerCase()}\\b`);
            if (reAbbr.test(lower) || (expectedFullState && lower.includes(expectedFullState))) {
                hasState = true;
            }
        }
        
        if (zip && expectedStateCode) return hasZip || hasState;
        if (zip) return hasZip;
        if (expectedStateCode) return hasState;
        return true;
      };

      // 1. Try structured city/state/zip first to prevent drifting
      if (lat === null && (city || zip) && state) {
        const r = await nominatimStructured({ city, state, postalcode: zip || undefined }, controller.signal);
        if (r && isValidMatch(r.matched)) { lat = r.lat; lng = r.lng; matched = r.matched; accuracy = "city_state"; }
      }

      // 2. Try street + zip structured
      if (lat === null && streetAddress && zip) {
        const r = await nominatimStructured({ street: streetAddress, postalcode: zip }, controller.signal);
        if (r && isValidMatch(r.matched)) { lat = r.lat; lng = r.lng; matched = r.matched; accuracy = "street_zip"; }
      }

      // 3. Try free text for full address, but validate it
      if (lat === null && normalizedAddress) {
        const q = addressHasInlineLocation
          ? normalizedAddress
          : [normalizedAddress, city, state, zip].filter(Boolean).join(", ");
        const r = await nominatimFree(q, controller.signal);
        if (r && isValidMatch(r.matched)) { lat = r.lat; lng = r.lng; matched = r.matched; accuracy = "address"; }
      }
      
      // 4. Fallback to reliable zip centroid
      if (lat === null && zip) {
        const r = await zipCentroid(zip, controller.signal);
        if (r) { lat = r.lat; lng = r.lng; matched = r.matched; accuracy = "zip_centroid"; }
      }

      // 5. Fallback to zip text search
      if (lat === null && zip) {
        const r = await nominatimFree(`${zip}, USA`, controller.signal);
        if (r) { lat = r.lat; lng = r.lng; matched = r.matched; accuracy = "zip_centroid"; }
      }
    } catch (e) {
      log("geocoding_exception", { message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(t);
    }

    // Fall back to stored coordinates only if geocoding produced nothing.
    if (lat === null && savedLocation && storedLat !== null && storedLng !== null) {
      lat = storedLat;
      lng = storedLng;
      accuracy = "coordinates";
      matched = sourceAddress;
      log("geocoding_fallback_to_stored", { storedLat, storedLng });
    }

    if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      log("geocoding_failed", { accuracy });
      return json(
        { code: "GEOCODING_FAILED", message: "The customer address could not be located. Check the saved address and try again." },
        422,
      );
    }
    log("coords_resolved", { accuracy });
    const guardedLocationUpdate = (values: Record<string, unknown>) => {
      let update = admin.from("leads").update(values).eq("id", leadId);
      for (const column of ["address", "half_address", "city", "state", "zip_code"] as const) {
        update = lead[column] === null ? update.is(column, null) : update.eq(column, lead[column]);
      }
      return update;
    };

    // Only a Census match of the saved location may update the free map.
    // Unsaved previews and city/ZIP fallback coordinates must not replace it.
    if (censusPoint && savedLocation && (lat !== storedLat || lng !== storedLng)) {
      const { error: coordinateError } = await guardedLocationUpdate({ latitude: lat, longitude: lng });
      if (coordinateError) log("census_coordinate_save_failed", { message: coordinateError.message });
    }

    // Dataset health check — before RPC, so we can distinguish outage from empty result.
    const { count: validCount, error: datasetErr } = await admin
      .from("us_places")
      .select("geoid", { count: "exact", head: true })
      .gt("population", 0);
    if (datasetErr) {
      log("dataset_query_failed", { code: datasetErr.code, message: datasetErr.message });
      return json(
        { code: "DATASET_QUERY_FAILED", message: "Nearby population data could not be queried. Please try again." },
        500,
      );
    }
    if (!validCount || validCount === 0) {
      log("dataset_empty", { validCount: validCount ?? 0 });
      return json(
        { code: "DATASET_EMPTY", message: "Nearby population data has not been loaded yet. Please contact an administrator." },
        503,
      );
    }
    log("dataset_ok", { validCount });

    const { data: rows, error: rpcErr } = await admin.rpc("get_top_nearby_populated_areas", {
      _latitude: lat,
      _longitude: lng,
    });
    if (rpcErr) {
      log("rpc_failed", { code: rpcErr.code, message: rpcErr.message, details: rpcErr.details });
      const notFound = /does not exist|not found|undefined function/i.test(rpcErr.message || "");
      return json(
        notFound
          ? { code: "RPC_NOT_FOUND", message: "The nearby-area database function is not available." }
          : { code: "NEARBY_QUERY_FAILED", message: "The nearby-area query failed." },
        notFound ? 500 : 500,
      );
    }

    const rawAreas = Array.isArray(rows) ? rows : [];
    const areas = rawAreas
      .filter((r) =>
        r &&
        r.geoid &&
        r.name &&
        r.state_code &&
        typeof r.population === "number" && Number.isFinite(r.population) && r.population > 0 &&
        typeof r.distance_miles === "number" && Number.isFinite(r.distance_miles) && r.distance_miles <= 50
      )
      .slice(0, 5)
      .map((r) => ({
        geoid: r.geoid,
        name: r.name,
        state_code: r.state_code,
        state_name: r.state_name,
        population: r.population,
        distance_miles: r.distance_miles,
      }));

    log("rpc_ok", { returned: rawAreas.length, kept: areas.length });

    const payload = {
      center_location: {
        source_address: sourceAddress || (placeName ?? ""),
        matched_address: matched || sourceAddress,
        latitude: lat,
        longitude: lng,
        geocoding_accuracy: accuracy,
        coordinate_provider: censusPoint ? "census" : accuracy === "coordinates" ? "stored" : "free-preview",
        place_name: placeName ?? null,
      },
      radius_miles: 50,
      method: "geocoder_and_census_population_dataset",
      population_vintage: 2023,
      generated_at: new Date().toISOString(),
      areas,
    };

    // Only persist when we have valid results; empty results are not saved.
    if (areas.length > 0 && savedLocation) {
      const { error: updErr } = await guardedLocationUpdate({ nearby_areas: payload });
      if (updErr) {
        log("save_failed", { code: updErr.code, message: updErr.message });
        return json({ code: "SAVE_FAILED", message: "Failed to save nearby areas." }, 500);
      }
    }

    if (areas.length === 0) {
      return json(
        {
          nearby_areas: payload,
          message: "No populated places were found within 50 miles.",
        },
        200,
      );
    }
    return json({ nearby_areas: payload });
  } catch (e) {
    log("uncaught", { message: e instanceof Error ? e.message : String(e) });
    return json({ code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) }, 500);
  }
});
