import { describe, expect, it } from "vitest";
import {
  addressComparisonKey,
  parseGoogleAddress,
  preserveAddressUnit,
} from "../../supabase/functions/_shared/google-address";

const googleResult = (overrides: Record<string, unknown> = {}) => ({
  formatted_address: "755 Vienna St, San Francisco, CA 94112, USA",
  types: ["street_address"],
  address_components: [
    { long_name: "755", short_name: "755", types: ["street_number"] },
    { long_name: "Vienna Street", short_name: "Vienna St", types: ["route"] },
    { long_name: "San Francisco", short_name: "SF", types: ["locality", "political"] },
    { long_name: "California", short_name: "CA", types: ["administrative_area_level_1", "political"] },
    { long_name: "94112", short_name: "94112", types: ["postal_code"] },
    { long_name: "United States", short_name: "US", types: ["country", "political"] },
  ],
  geometry: { location: { lat: 37.7631, lng: -122.4402 } },
  ...overrides,
});

describe("google address verification", () => {
  it("returns a confirmed US street address with its components", () => {
    const match = parseGoogleAddress(googleResult());
    expect(match).toMatchObject({ city: "San Francisco", state: "CA", zip: "94112", formattedAddress: "755 Vienna St, San Francisco, CA 94112, USA" });
  });

  it("refuses partial, city-level and non-US results", () => {
    expect(parseGoogleAddress(googleResult({ partial_match: true }))).toBeNull();
    expect(parseGoogleAddress(googleResult({ types: ["locality"] }))).toBeNull();
    expect(parseGoogleAddress(googleResult({
      address_components: googleResult().address_components.filter((part) => !part.types.includes("street_number")),
    }))).toBeNull();
    expect(parseGoogleAddress(undefined)).toBeNull();
  });

  // The reported defect: a Google-formatted address was rejected purely because it
  // is written differently from the customer's text.
  it("treats formatting differences as the same location", () => {
    const customer = "755 vienna st san francisco ca 94112 usa";
    const google = "755 Vienna Street, San Francisco, California 94112";
    expect(addressComparisonKey(customer)).not.toBe(google.toLowerCase());
    expect(addressComparisonKey(customer)).toBe(addressComparisonKey(google));
    expect(addressComparisonKey("1600 Pennsylvania Avenue NW, Washington, DC 20500"))
      .toBe(addressComparisonKey("1600 pennsylvania ave n.w. washington dc 20500 united states"));
  });

  it("keeps a customer unit that Google dropped", () => {
    expect(preserveAddressUnit("755 Vienna St, San Francisco, CA 94112", "755 Vienna St #4B")).toContain("#4B");
    expect(preserveAddressUnit("755 Vienna St, San Francisco, CA 94112", "755 Vienna St apartment 4B")).toContain("Apartment 4B");
    expect(preserveAddressUnit("755 Vienna St, San Francisco, CA 94112, USA", "755 vienna st apt 4b"))
      .toContain("Apt 4b");
    // Already present: do not duplicate it.
    expect(preserveAddressUnit("755 Vienna St, Apt 4B, San Francisco, CA 94112, USA", "755 vienna st apt 4b"))
      .not.toMatch(/apt 4b.*apt 4b/i);
  });
});
