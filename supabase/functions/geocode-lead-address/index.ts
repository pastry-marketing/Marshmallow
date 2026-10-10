import { createClient } from "npm:@supabase/supabase-js@2";
import { lookupCensusAddress } from "../_shared/census-address.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  try {
    // Shared coordinate endpoint for CRM/Donut/coverage. Google credentials
    // intentionally have no effect on the free OpenStreetMap coordinate path.
    return jsonResponse({ match: await lookupCensusAddress(address) });
  } catch (error) {
    console.error("Census address lookup failed:", error);
    return jsonResponse({ error: "Address provider is temporarily unavailable" }, 502);
  }
});
