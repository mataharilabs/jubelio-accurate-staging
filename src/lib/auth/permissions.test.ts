import { describe, expect, it } from "vitest";
import { hasPermission, sanitizePermissions } from "@/lib/auth/permissions";

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
});
