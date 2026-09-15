import { describe, expect, it } from "vitest";
import { canAccessNavItem, canSeeTechDetails, getDefaultNavAccess } from "@/lib/access";
import type { NavigationPermission } from "@/types";

describe("cancellation request navigation access", () => {
  it.each(["admin", "processor"] as const)("is always visible to %s", (role) => {
    const deniedOverride = [{ nav_section: "cancellation_requests", allowed: false }] as NavigationPermission[];

    expect(getDefaultNavAccess(role).has("cancellation_requests")).toBe(true);
    expect(canAccessNavItem(role, "cancellation_requests", deniedOverride)).toBe(true);
  });

  // Operators were narrowed to All Leads only in "set default nav access for opr to only all leads".
  it("is not part of the Operator default navigation", () => {
    expect(getDefaultNavAccess("opr").has("cancellation_requests")).toBe(false);
    expect(canAccessNavItem("opr", "cancellation_requests")).toBe(false);
  });

  it("remains hidden from roles outside the requested audience", () => {
    expect(canAccessNavItem("customer_service", "cancellation_requests")).toBe(false);
    expect(canAccessNavItem("cs_admin", "cancellation_requests")).toBe(false);
    expect(canAccessNavItem(null, "cancellation_requests")).toBe(false);
  });
});

describe("quo monitor navigation access", () => {
  it("is visible to admin by default", () => {
    expect(getDefaultNavAccess("admin").has("quo_monitor")).toBe(true);
    expect(canAccessNavItem("admin", "quo_monitor")).toBe(true);
  });

  it.each(["processor", "customer_service", "opr"] as const)("is hidden from %s", (role) => {
    expect(getDefaultNavAccess(role).has("quo_monitor")).toBe(false);
    expect(canAccessNavItem(role, "quo_monitor")).toBe(false);
  });

  it("denies navigation entirely when the user has no valid role", () => {
    expect(canAccessNavItem(null, "quo_monitor")).toBe(false);
    expect(canAccessNavItem(null, "leads")).toBe(false);
  });

  it("respects per-user navigation overrides for quo monitor", () => {
    const allowedOverride = [{ nav_section: "quo_monitor", allowed: true }] as NavigationPermission[];

    expect(canAccessNavItem("processor", "quo_monitor", allowedOverride)).toBe(true);
    expect(canAccessNavItem("customer_service", "quo_monitor", allowedOverride)).toBe(true);
  });
});

describe("technician details", () => {
  it("are hidden from CS Admins", () => {
    expect(canSeeTechDetails("cs_admin")).toBe(false);
  });

  it("stay visible to everyone else", () => {
    for (const role of ["admin", "processor", "customer_service", "opr"] as const) {
      expect(canSeeTechDetails(role)).toBe(true);
    }
  });
});

describe("OPR Admin inheritance", () => {
  it("has the same default navigation as OPR", () => {
    expect([...getDefaultNavAccess("opr_admin")]).toEqual([...getDefaultNavAccess("opr")]);
  });
});
