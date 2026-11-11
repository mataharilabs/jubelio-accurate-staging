import { describe, expect, it } from "vitest";
import { ADMIN_ROLE, canMaintainMaster, hasPermission, sanitizePermissions, SUPER_ADMIN_ROLE } from "@/lib/auth/permissions";

describe("permissions", () => {
  it("keeps only known permission keys", () => {
    expect(sanitizePermissions(["dashboard.view", "nope", "sync.execute"])).toEqual(["dashboard.view", "sync.execute"]);
  });

  it("denies a permission the role does not have", () => {
    const granted = sanitizePermissions(["dashboard.view"]);
    expect(hasPermission(granted, "dashboard.view")).toBe(true);
    expect(hasPermission(granted, "sync.execute")).toBe(false);
    expect(hasPermission(granted, "users.manage")).toBe(false);
  });

  it("lets Super Admin and Admin maintain master data, and a custom role only with the permission", () => {
    expect(canMaintainMaster(SUPER_ADMIN_ROLE, [], "orders.edit")).toBe(true);
    expect(canMaintainMaster(ADMIN_ROLE, [], "orders.edit")).toBe(true);
    expect(canMaintainMaster("Finance", ["orders.view"], "orders.edit")).toBe(false);
    expect(canMaintainMaster("Finance", ["products.manage"], "products.manage")).toBe(true);
  });
});
