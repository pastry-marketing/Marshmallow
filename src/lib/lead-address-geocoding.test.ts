import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), from: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: mocks.invoke }, from: mocks.from } }));
let geocode: typeof import("./lead-address-geocoding");

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  const query = { update: mocks.update, eq: mocks.eq, select: mocks.select, maybeSingle: mocks.maybeSingle };
  mocks.from.mockReturnValue(query); mocks.update.mockReturnValue(query); mocks.eq.mockReturnValue(query); mocks.select.mockReturnValue(query);
  mocks.maybeSingle.mockResolvedValue({ data: { id: "lead" }, error: null });
  geocode = await import("./lead-address-geocoding");
});

describe("CRM Census-only map coordinates", () => {
  it("saves Census coordinates without replacing the customer-entered address", async () => {
    mocks.invoke.mockResolvedValue({ data: { match: { provider: "census", latitude: 37.7, longitude: -122.4, matchedAddress: "Standardized street address", city: "San Francisco", state: "CA", zip: "94112" } }, error: null });
    expect(await geocode.geocodeAndPersistLeadAddress("lead", "755 Vienna St #4B San Francisco CA")).toBe(true);
    const update = mocks.update.mock.calls[0][0];
    expect(update).toMatchObject({ latitude: 37.7, longitude: -122.4, zip_code: "94112" });
    expect(update).not.toHaveProperty("address");
    expect(mocks.eq).toHaveBeenCalledWith("address", "755 Vienna St #4B San Francisco CA");
  });

  it.each(["google", undefined])("rejects %s coordinates before caching or saving them", async (provider) => {
    mocks.invoke.mockResolvedValue({ data: { match: { provider, latitude: 37.7, longitude: -122.4 } }, error: null });
    await expect(geocode.geocodeLeadAddress("755 Vienna St, San Francisco CA")).rejects.toThrow("must come from Census");
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValue({ data: { match: { provider: "census", latitude: 37.7, longitude: -122.4 } }, error: null });
    expect((await geocode.geocodeLeadAddress("755 Vienna St, San Francisco CA"))?.provider).toBe("census");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});
