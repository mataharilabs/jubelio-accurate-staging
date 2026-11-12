export type ProductFilterRow = {
  sku: string;
  name: string;
  brandId: string | null;
  categoryId: string | null;
  active: boolean;
  hpp: number | null;
  accurateFound: string;
};

export type ProductFilter = {
  q?: string;
  brandId?: string;
  categoryId?: string;
  ordered?: "yes" | "no";
  noHpp?: boolean;
  notInAccurate?: boolean;
  incomplete?: boolean;
  confirmed?: "yes" | "no";
  active?: "active" | "deleted" | "all";
};

export const NO_BRAND = "none";
export const NO_CATEGORY = "none";

function incomplete(row: ProductFilterRow): boolean {
  return !row.name.trim() || !row.categoryId || !row.brandId;
}

/** Server-side Master Produk filter. `orderedSkus` is null when that filter is off. */
export function matchesProductQuery(row: ProductFilterRow, query: ProductFilter, orderedSkus: ReadonlySet<string> | null): boolean {
  const q = query.q?.trim().toLowerCase() ?? "";
  if (q && !`${row.sku} ${row.name}`.toLowerCase().includes(q)) return false;
  if (query.brandId === NO_BRAND) {
    if (row.brandId) return false;
  } else if (query.brandId && row.brandId !== query.brandId) return false;
  if (query.categoryId === NO_CATEGORY) {
    if (row.categoryId) return false;
  } else if (query.categoryId && row.categoryId !== query.categoryId) return false;
  if (query.ordered === "yes" && !orderedSkus?.has(row.sku)) return false;
  if (query.ordered === "no" && orderedSkus?.has(row.sku)) return false;
  if (query.noHpp && row.hpp != null) return false;
  if (query.confirmed === "no" && row.hpp != null) return false;
  if (query.confirmed === "yes" && row.hpp == null) return false;
  if (query.active === "active" && row.active === false) return false;
  if (query.active === "deleted" && row.active !== false) return false;
  if (query.notInAccurate && row.accurateFound !== "false") return false;
  if (query.incomplete && !incomplete(row)) return false;
  return true;
}
