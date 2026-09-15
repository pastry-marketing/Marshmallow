import type { AppRole, NavigationPermission, LeadStatus } from "@/types";
import { ALL_LEAD_STATUSES, ALL_NAV_ITEMS, type NavItem } from "@/lib/constants";

const DEFAULT_NAV_ACCESS: Record<AppRole, Set<NavItem>> = {
  admin: new Set(ALL_NAV_ITEMS),
  processor: new Set(["leads", "schedule", "cancellation_requests", "map_view", "technicians"]),
  customer_service: new Set(["leads", "schedule"]),
  opr: new Set(["leads"]),
  cs_admin: new Set(["leads", "schedule"]),
  // opr_admin mirrors opr's default access; the Technicians tab is granted per
  // user via navigation permissions, and unlocks add/import for this role.
  opr_admin: new Set(["leads"]),
};

/** Roles that may add a technician when they have the Technicians tab. */
export function canAddTechnicians(role: AppRole | null | undefined): boolean {
  return role === "admin" || role === "processor" || role === "opr" || role === "opr_admin";
}

/** Roles that may bulk-import technicians (regular opr cannot). */
export function canImportTechnicians(role: AppRole | null | undefined): boolean {
  return role === "admin" || role === "processor" || role === "opr_admin";
}

/** Only admins may export data anywhere in the app. */
export function canExportData(role: AppRole | null | undefined): boolean {
  return role === "admin";
}

/** opr_admin must pick an OPR code; a regular opr is locked to their own. */
export function mustChooseOprCode(role: AppRole | null | undefined): boolean {
  return role === "admin" || role === "opr_admin";
}

/**
 * How the Technicians list is scoped for a role:
 * - "all": admin / processor see every technician
 * - "coded": opr_admin sees any technician with an OPR code (legacy ones hidden)
 * - "own": opr sees only technicians with their own OPR code
 */
export function technicianVisibility(role: AppRole | null | undefined): "all" | "coded" | "own" {
  if (role === "opr") return "own";
  if (role === "opr_admin") return "coded";
  return "all";
}

export const canAccessCancellationRequests = (role: AppRole | null | undefined) =>
  role === "admin" || role === "processor";

/**
 * opr_admin has the same access as a regular opr (read-only leads, urgent-only,
 * etc.), so lead-side restrictions treat both the same.
 */
export function isOperatorRole(role: AppRole | null | undefined): boolean {
  return role === "opr" || role === "opr_admin";
}

export function getDefaultNavAccess(role: AppRole): Set<NavItem> {
  return new Set(DEFAULT_NAV_ACCESS[role]);
}

export function canAccessNavItem(
  role: AppRole | null | undefined,
  navItem: string,
  permissions: NavigationPermission[] = [],
): boolean {
  if (!role) {
    return false;
  }

  if (!ALL_NAV_ITEMS.includes(navItem as NavItem)) {
    return false;
  }

  if (role === "admin") {
    return true;
  }

  if (navItem === "payment_requests") {
    // Admin-only page
    return false;
  }

  if (navItem === "crm_updates") {
    // Admin-only page
    return false;
  }


  if (navItem === "cancellation_requests" && canAccessCancellationRequests(role)) {
    return true;
  }

  const override = permissions.find((permission) => permission.nav_section === navItem);
  if (override) {
    return override.allowed;
  }

  return getDefaultNavAccess(role).has(navItem as NavItem);
}

const CS_ADMIN_HIDDEN_STATUSES: LeadStatus[] = ["paid", "partial_paid", "cancelled", "job_done"];
const ADMIN_ONLY_STATUSES: LeadStatus[] = ["pending_to_send", "quote_updated"];

export function getDefaultVisibleStatuses(role: AppRole | null | undefined): Set<LeadStatus> {
  if (!role) {
    return new Set();
  }
  if (role === "admin") {
    return new Set(ALL_LEAD_STATUSES);
  }
  
  const baseExclude = ["scammed", "quote_change", ...ADMIN_ONLY_STATUSES];
  
  if (role === "opr" || role === "opr_admin") {
    return new Set<LeadStatus>(["urgent_job"]);
  }
  if (role === "processor") {
    return new Set(ALL_LEAD_STATUSES.filter((s) => !ADMIN_ONLY_STATUSES.includes(s)));
  }
  if (role === "cs_admin") {
    const csAdminExclude = ["scammed", "quote_change", "quote_updated", ...CS_ADMIN_HIDDEN_STATUSES];
    return new Set<LeadStatus>(ALL_LEAD_STATUSES.filter((s) => !csAdminExclude.includes(s)));
  }

  // customer_service never see base exclusions by default.
  return new Set<LeadStatus>(ALL_LEAD_STATUSES.filter((s) => !baseExclude.includes(s)));
}

/**
 * Technician name, number and details. Hidden from CS Admins wherever a lead is shown - the
 * lead card, the lead detail page, and the Schedule page (64a67ac) - so the rule lives here once.
 */
export function canSeeTechDetails(role: AppRole | null | undefined): boolean {
  return role !== "cs_admin";
}
