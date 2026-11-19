import { describe, expect, it } from "vitest";
import type { DashboardReport } from "@/lib/db/types";
import { applyMarketingAllocation, overlapFactor, storeProfit } from "@/lib/marketing/allocate";

function report(): DashboardReport {
  return {
    kpis: { gross: 100, disc: 10, net: 90, orders: 2, qty: 3, aov: 45, days: 2, hpp: 20, fee: 0, marketing: 0, profit: 70, missingSkus: 0 },
    trend: [],
    channels: [],
    stores: [{ key: "Jansen Official Store", gross: 100, net: 90, qty: 3, orders: 2, hpp: 20, profit: 70 }],
    products: [],
    provinces: [],
    cities: [],
  };
}

describe("marketing allocation", () => {
  it("keeps a full weekly spend when the dashboard window covers it", () => {
    const next = applyMarketingAllocation(report(), [
      { storeName: "Jansen Official Store", periodStart: "2026-11-09", periodEnd: "2026-11-15", spend: 700 },
    ], { from: "2026-11-01", to: "2026-11-19", stores: [], granularity: "day" });
    expect(overlapFactor("2026-11-09", "2026-11-15", "2026-11-01", "2026-11-19")).toBe(1);
    expect(next.kpis.marketing).toBe(700);
    expect(next.stores[0]?.marketing).toBe(700);
    expect(next.kpis.profit).toBe(70);
  });

  it("prorates a partial window and adds a store that only has ads", () => {
    expect(overlapFactor("2026-11-09", "2026-11-15", "2026-11-14", "2026-11-15")).toBeCloseTo(2 / 7);
    const next = applyMarketingAllocation(report(), [
      { storeName: "Jansen Official Store", periodStart: "2026-11-09", periodEnd: "2026-11-15", spend: 700 },
      { storeName: "Bee & Flower", periodStart: "2026-11-15", periodEnd: "2026-11-15", spend: 50 },
    ], { from: "2026-11-15", to: "2026-11-15", stores: [], granularity: "day" });
    expect(next.kpis.marketing).toBeCloseTo(100 + 50, 2);
    expect(next.stores.find((row) => row.key === "Bee & Flower")?.marketing).toBe(50);
    const filtered = applyMarketingAllocation(report(), [
      { storeName: "Bee & Flower", periodStart: "2026-11-15", periodEnd: "2026-11-15", spend: 50 },
    ], { from: "2026-11-01", to: "2026-11-19", stores: ["Jansen Official Store"], granularity: "day" });
    expect(filtered.kpis.marketing).toBe(0);
  });

  it("subtracts a day's marketing from store profit without changing the stored profit field", () => {
    expect(storeProfit(1000, 400, 0, 100)).toBe(500);
    const base = report();
    base.kpis = { ...base.kpis, net: 1000, hpp: 400, fee: 0, profit: 600 };
    base.trend = [{ bucket: "2026-11-09", label: "9 Nov", gross: 1000, net: 1000, orders: 1, hpp: 400, profit: 600 }];
    const next = applyMarketingAllocation(base, [
      { storeName: "Jansen Official Store", periodStart: "2026-11-09", periodEnd: "2026-11-09", spend: 100 },
    ], { from: "2026-11-09", to: "2026-11-09", stores: [], granularity: "day" });
    expect(next.trend[0]?.marketing).toBe(100);
    expect(next.trend[0]?.profit).toBe(600);
    expect(storeProfit(next.trend[0]?.net ?? 0, next.trend[0]?.hpp ?? 0, 0, next.trend[0]?.marketing ?? 0)).toBe(500);
    expect(storeProfit(next.kpis.net, next.kpis.hpp, next.kpis.fee, next.kpis.marketing)).toBe(500);
  });
});
