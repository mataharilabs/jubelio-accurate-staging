import { describe, expect, it } from "vitest";

/**
 * Mirrors public.sku_fee_shares after 0017: a fee SKU that is not one of the
 * order's line SKUs is shared (spread by sales share), not dropped.
 * Lazada pack SKU MRI001001L-10 vs line MRI001001L. Blibli 40100083 vs 40100083-01.
 */
function feePlacement(feeSku: string | null, lineSkus: readonly string[]): "direct" | "shared" {
  if (feeSku && lineSkus.includes(feeSku)) return "direct";
  return "shared";
}

describe("sku fee placement", () => {
  it("keeps an exact line SKU and spreads a pack or seller SKU that the order does not have", () => {
    expect(feePlacement("MRI001001L", ["MRI001001L"])).toBe("direct");
    expect(feePlacement("MRI001001L-10", ["MRI001001L"])).toBe("shared");
    expect(feePlacement("40100083", ["40100083-01"])).toBe("shared");
    expect(feePlacement("40100083-01", ["40100083-01"])).toBe("direct");
    expect(feePlacement(null, ["MRI001001L"])).toBe("shared");
  });
});
