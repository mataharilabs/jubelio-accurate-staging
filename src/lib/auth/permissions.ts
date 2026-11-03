export const PERMISSIONS = [
  "dashboard.view",
  "dashboard.export",
  "orders.view",
  "orders.edit",
  "orders.export",
  "import.upload",
  "import.pull",
  "sync.view",
  "sync.confirm",
  "sync.execute",
  "mappings.manage",
  "weights.manage",
  "settings.manage",
  "products.view",
  "products.manage",
  "hpp.sync",
  "users.manage",
  "roles.manage",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SUPER_ADMIN_ROLE = "Super Admin";

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function sanitizePermissions(values: unknown): Permission[] {
  if (!Array.isArray(values)) return [];
  const unique = new Set<Permission>();
  for (const value of values) {
    if (typeof value === "string" && isPermission(value)) unique.add(value);
  }
  return [...unique];
}

export function hasPermission(granted: readonly string[], permission: Permission): boolean {
  return granted.includes(permission);
}
