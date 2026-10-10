// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupCensusAddress, parseCensusAddress } from "../../supabase/functions/_shared/census-address";

afterEach(() => vi.unstubAllGlobals());
class TestResponse {
  constructor(private body: string, public options: { status: number }) {}
  get status() { return this.options.status; }
  async json() { return JSON.parse(this.body); }
}
const source = (file: string) => transformSync(readFileSync(file, "utf8").replace(/^import .*;\r?$/gm, ""), { loader: "ts", format: "esm" }).code;
const censusPayload = { result: { addressMatches: [{ matchedAddress: "755 VIENNA ST, SAN FRANCISCO, CA, 94112", coordinates: { x: -122.4, y: 37.7 }, addressComponents: { city: "San Francisco", state: "CA", zip: "94112" } }] } };

describe("Census-only shared coordinate endpoint", () => {
  it("uses only Census even when Google credentials are configured", async () => {
    const fetcher = vi.fn(async (_url: unknown) => ({ ok: true, json: async () => censusPayload }));
    vi.stubGlobal("fetch", fetcher);
    let handler!: (request: unknown) => Promise<TestResponse>;
    runInNewContext(source("supabase/functions/geocode-lead-address/index.ts"), {
      createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "fixture-user" } }, error: null }) } }),
      lookupCensusAddress, Response: TestResponse,
      Deno: { env: { get: () => "configured-including-google" }, serve: (callback: typeof handler) => { handler = callback; } },
    });
    const response = await handler({ method: "POST", headers: { get: () => "Bearer fixture" }, json: async () => ({ address: "755 Vienna St #4B, San Francisco CA 94112" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).match).toMatchObject({ provider: "census", latitude: 37.7, longitude: -122.4, matchedAddress: expect.stringContaining("#4B") });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("https://geocoding.geo.census.gov/");
  });

  it("rejects ambiguous or missing coordinates instead of guessing a map point", () => {
    expect(parseCensusAddress({ result: { addressMatches: [censusPayload.result.addressMatches[0], censusPayload.result.addressMatches[0]] } }, "address")).toBeNull();
    expect(parseCensusAddress({ result: { addressMatches: [{ matchedAddress: "address", coordinates: { x: null, y: null } }] } }, "address")).toBeNull();
    expect(parseCensusAddress({ result: { addressMatches: [null] } }, "address")).toBeNull();
  });
});

function nearby(census: boolean) {
  const lead = { id: "lead", address: "755 Vienna St, San Francisco, CA 94112", half_address: null, city: "San Francisco", state: "CA", zip_code: "94112", latitude: 38, longitude: -123 };
  const updates: Record<string, unknown>[] = [];
  const filters: unknown[][] = [];
  const from = (table: string) => {
    const result = { data: table === "user_roles" ? { role: "admin" } : lead, error: null, count: 1 };
    const query = {
      select: () => query, gt: () => query,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
      is: (column: string, value: unknown) => { filters.push([column, value]); return query; },
      update: (value: Record<string, unknown>) => { updates.push(value); return query; },
      maybeSingle: async () => result,
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  };
  const lookup = vi.fn(async () => census ? { latitude: 37.7, longitude: -122.4, provider: "census", matchedAddress: lead.address } : null);
  let handler!: (request: unknown) => Promise<TestResponse>;
  runInNewContext(source("supabase/functions/generate-nearby-areas/index.ts"), {
    createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "user" } }, error: null }) }, from,
      rpc: async () => ({ data: [{ geoid: "place", name: "Nearby city", state_code: "CA", population: 20000, distance_miles: 5 }], error: null }) }),
    lookupCensusAddress: lookup, Response: TestResponse, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: vi.fn(async () => ({ ok: true, json: async () => [{ lat: "37.0", lon: "-122.0", display_name: "San Francisco, California, 94112" }] })),
    Deno: { env: { get: () => "fixture" }, serve: (callback: typeof handler) => { handler = callback; } },
    console: { log: vi.fn() },
  });
  const request = (extra = {}) => handler({ method: "POST", headers: { get: () => "Bearer fixture" }, json: async () => ({ leadId: "lead", ...extra }) });
  return { request, updates, filters, lookup };
}

describe("nearby-area map coordinate preservation", () => {
  it("persists a Census match of the saved address with a location-snapshot guard", async () => {
    const fixture = nearby(true);
    expect((await fixture.request()).status).toBe(200);
    expect(fixture.updates).toContainEqual({ latitude: 37.7, longitude: -122.4 });
    expect(fixture.filters).toContainEqual(["address", "755 Vienna St, San Francisco, CA 94112"]);
    expect(fixture.filters).toContainEqual(["half_address", null]);
  });

  it("does not replace a lead's map point with a city/ZIP fallback", async () => {
    const fixture = nearby(false);
    const response = await fixture.request();
    expect(response.status).toBe(200);
    expect(fixture.updates.some(update => "latitude" in update || "longitude" in update)).toBe(false);
    expect((await response.json()).nearby_areas.center_location.coordinate_provider).toBe("free-preview");
  });

  it("does not save coordinates or nearby-area snapshots from an unsaved address preview", async () => {
    const fixture = nearby(true);
    expect((await fixture.request({ customerAddress: "123 Other St, San Francisco CA" })).status).toBe(200);
    expect(fixture.updates).toHaveLength(0);
  });
});
