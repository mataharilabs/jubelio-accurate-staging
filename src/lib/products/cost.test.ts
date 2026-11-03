import { describe, expect, it } from "vitest";
import { effectiveCost, grossProfit, hppCoverage } from "@/lib/products/cost";

describe("effective HPP", () => {
  it("uses the latest cost for every sale, and lets a same-day manual entry win", () => {
    const chosen = effectiveCost([
      { sku: "A", costDate: "2026-10-01", unitCost: 1000, source: "accurate", fetchedAt: "2026-10-01T00:00:00Z" },
      { sku: "A", costDate: "2026-11-01", unitCost: 1500, source: "accurate", fetchedAt: "2026-11-01T00:00:00Z" },
      { sku: "A", costDate: "2026-11-01", unitCost: 900, source: "manual", fetchedAt: "2026-11-01T01:00:00Z" },
    ]);
    expect(chosen?.unitCost).toBe(900);
    expect(chosen?.source).toBe("manual");
    expect(grossProfit(10000, 4, chosen?.unitCost ?? null)).toBe(6400);
  });

  it("lets a newer Accurate cost replace an older manual cost", () => {
    const chosen = effectiveCost([
      { sku: "A", costDate: "2026-10-01", unitCost: 900, source: "manual", fetchedAt: "2026-10-01T00:00:00Z" },
      { sku: "A", costDate: "2026-11-03", unitCost: 1200, source: "accurate", fetchedAt: "2026-11-03T10:00:00Z" },
    ]);
    expect(chosen?.source).toBe("accurate");
    expect(chosen?.unitCost).toBe(1200);
  });

  it("counts SKUs that still have no HPP", () => {
    expect(hppCoverage([{ unitCost: 1 }, { unitCost: null }, { unitCost: 2 }])).toEqual({ skus: 3, withHpp: 2, percent: 66.7 });
    expect(grossProfit(5000, 2, null)).toBeNull();
  });
});
