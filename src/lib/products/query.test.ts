import { describe, expect, it } from "vitest";
import { matchesProductQuery, type ProductFilterRow } from "@/lib/products/query";

function row(patch: Partial<ProductFilterRow> = {}): ProductFilterRow {
  return {
    sku: "NTMVTD8001L",
    name: "Nutrimax Vitamin D3+K2",
    brandId: null,
    categoryId: null,
    active: true,
    hpp: 1000,
    accurateFound: "unknown",
    ...patch,
  };
}

describe("product master filters", () => {
  it("combines search, empty brand, empty category, and never ordered", () => {
    const ordered = new Set(["LAIN"]);
    expect(matchesProductQuery(row(), {
      q: "nutrimax",
      brandId: "none",
      categoryId: "none",
      ordered: "no",
    }, ordered)).toBe(true);
    expect(matchesProductQuery(row({ brandId: "brand-1" }), { brandId: "none" }, null)).toBe(false);
    expect(matchesProductQuery(row({ categoryId: "cat-1" }), { categoryId: "none" }, null)).toBe(false);
    expect(matchesProductQuery(row(), { ordered: "yes" }, ordered)).toBe(false);
    expect(matchesProductQuery(row(), { ordered: "yes", brandId: "brand-1" }, new Set(["NTMVTD8001L"]))).toBe(false);
    expect(matchesProductQuery(row({ brandId: "brand-1" }), { ordered: "yes", brandId: "brand-1" }, new Set(["NTMVTD8001L"]))).toBe(true);
  });
});
