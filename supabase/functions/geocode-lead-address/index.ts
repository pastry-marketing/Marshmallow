import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const CENSUS_BENCHMARK = "Public_AR_Current";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authorization = req.headers.get("Authorization");
  if (!authorization) return jsonResponse({ error: "Sign in to geocode an address" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Supabase geocoder environment is incomplete");
    return jsonResponse({ error: "Address lookup is temporarily unavailable" }, 500);
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return jsonResponse({ error: "Sign in to geocode an address" }, 401);

  let address: string;
  try {
    const body = await req.json();
    address = typeof body?.address === "string" ? body.address.trim() : "";
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  if (address.length < 8 || address.length > 300) {
    return jsonResponse({ error: "Enter a full street address to look up" }, 400);
  }

  const url = new URL(CENSUS_GEOCODER_URL);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", CENSUS_BENCHMARK);
  url.searchParams.set("format", "json");

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return jsonResponse({ error: "Address provider is temporarily unavailable" }, 502);
    }
    const payload = await response.json();
    const match = payload?.result?.addressMatches?.[0];
    const longitude = Number(match?.coordinates?.x);
    const latitude = Number(match?.coordinates?.y);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return jsonResponse({ match: null });
    }

    return jsonResponse({
      match: {
        latitude,
        longitude,
        matchedAddress: typeof match?.matchedAddress === "string"
          ? match.matchedAddress.trim()
          : null,
        city: typeof match?.addressComponents?.city === "string"
          ? match.addressComponents.city.trim()
          : null,
        state: typeof match?.addressComponents?.state === "string"
          ? match.addressComponents.state.trim().toUpperCase()
          : null,
        zip: typeof match?.addressComponents?.zip === "string"
          ? match.addressComponents.zip.trim()
          : null,
      },
    });
  } catch (error) {
    console.error("Census address lookup failed:", error);
    return jsonResponse({ error: "Address provider is temporarily unavailable" }, 502);
  }
});
