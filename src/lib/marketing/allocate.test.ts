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

  it("sends Meta, CPAS, and Shopee ads to Shopee and splits TikTok ads by revenue", () => {
    const base = report();
    base.stores = [
      { key: "Jansen Official Store", gross: 0, net: 906_800_000, qty: 1, orders: 1, hpp: 0, fee: 0, profit: 0 },
      { key: "Bee & Flower", gross: 0, net: 293_900_000, qty: 1, orders: 1, hpp: 0, fee: 0, profit: 0 },
    ];
    base.channels = [
      { key: "Shopee", gross: 0, net: 1, qty: 1, orders: 1, hpp: 0, fee: 0, profit: 0 },
      { key: "Tiktok", gross: 0, net: 1, qty: 1, orders: 1, hpp: 0, fee: 0, profit: 0 },
      { key: "Tokopedia", gross: 0, net: 1, qty: 1, orders: 1, hpp: 0, fee: 0, profit: 0 },
    ];
    base.allocBase = [
      { store: "Jansen Official Store", channel: "Shopee", net: 308_140_982, hpp: 0, fee: 0 },
      { store: "Jansen Official Store", channel: "Tiktok", net: 394_748_317, hpp: 0, fee: 0 },
      { store: "Jansen Official Store", channel: "Tokopedia", net: 184_318_274, hpp: 0, fee: 0 },
      { store: "Bee & Flower", channel: "Shopee", net: 188_824_087, hpp: 0, fee: 0 },
      { store: "Bee & Flower", channel: "Tiktok", net: 55_055_140, hpp: 0, fee: 0 },
      { store: "Bee & Flower", channel: "Tokopedia", net: 36_884_350, hpp: 0, fee: 0 },
      { store: "Pristine Aroma", channel: "Shopee", net: 37_194_144, hpp: 0, fee: 0 },
    ];
    const spends = [
      { storeName: "Bee & Flower", platform: "CPAS", periodStart: "2026-10-01", periodEnd: "2026-10-31", spend: 1_946_989, adsRevenue: 8_975_909 },
      { storeName: "Bee & Flower", platform: "Meta Ads", periodStart: "2026-10-01", periodEnd: "2026-10-31", spend: 2_799_812, adsRevenue: null },
      { storeName: "Bee & Flower", platform: "Shopee Ads", periodStart: "2026-10-01", periodEnd: "2026-10-31", spend: 10_152_115, adsRevenue: 139_163_628 },
      { storeName: "Bee & Flower", platform: "TikTok Ads", periodStart: "2026-10-01", periodEnd: "2026-10-31", spend: 10_346_358, adsRevenue: 89_517_861 },
      { storeName: "Jansen Official Store", platform: "Shopee Ads", periodStart: "2026-10-01", periodEnd: "2026-10-31", spend: 12_632_533, adsRevenue: 194_050_728 },
      { storeName: "Jansen Official Store", platform: "TikTok Ads", periodStart: "2026-10-01", periodEnd: "2026-10-31", spend: 47_542_977, adsRevenue: 580_266_658 },
      { storeName: "Pristine Aroma", platform: "Shopee Ads", periodStart: "2026-10-01", periodEnd: "2026-10-31", spend: 4_679_509, adsRevenue: 26_370_744 },
    ];
    const query = { from: "2026-10-01", to: "2026-10-31", stores: [], channels: [], granularity: "month" as const };
    const next = applyMarketingAllocation(base, spends, query);
    expect(next.kpis.marketing).toBe(90_100_293);
    expect(next.stores.find((row) => row.key === "Jansen Official Store")?.marketing).toBe(60_175_510);
    expect(next.stores.find((row) => row.key === "Bee & Flower")?.marketing).toBe(25_245_274);
    expect(next.marketingLines?.find((row) => row.platform === "Meta Ads")?.channels).toEqual(["Shopee"]);
    expect(next.marketingLines?.find((row) => row.platform === "CPAS")?.channels).toEqual(["Shopee"]);
    const shopee = applyMarketingAllocation(base, spends, { ...query, channels: ["Shopee"] });
    expect(shopee.kpis.marketing).toBe(32_210_958);
    expect(shopee.marketingLines?.every((row) => row.platform !== "TikTok Ads")).toBe(true);
    const tiktokShare = (spend: number, tiktok: number, tokopedia: number) => Math.round(spend * (tiktok / (tiktok + tokopedia)) * 100) / 100;
    const tiktok = applyMarketingAllocation(base, spends, { ...query, channels: ["Tiktok"] });
    const expectedTiktok = tiktokShare(47_542_977, 394_748_317, 184_318_274) + tiktokShare(10_346_358, 55_055_140, 36_884_350);
    expect(tiktok.kpis.marketing).toBeCloseTo(expectedTiktok, 2);
    expect(tiktok.kpis.marketing).toBeLessThan(47_542_977 + 10_346_358);
  });

  it("scales platform ad revenue with the visible share of spend", () => {
    const base = report();
    base.allocBase = [
      { store: "Jansen Official Store", channel: "Tiktok", net: 50, hpp: 0, fee: 0 },
      { store: "Jansen Official Store", channel: "Tokopedia", net: 50, hpp: 0, fee: 0 },
    ];
    const next = applyMarketingAllocation(base, [
      { storeName: "Jansen Official Store", platform: "TikTok Ads", periodStart: "2026-10-01", periodEnd: "2026-10-01", spend: 100, adsRevenue: 1000 },
    ], { from: "2026-10-01", to: "2026-10-01", stores: [], channels: ["Tiktok"], granularity: "day" });
    expect(next.kpis.marketing).toBe(50);
    expect(next.marketingLines?.[0]?.spend).toBe(50);
    expect(next.marketingLines?.[0]?.adsRevenue).toBe(500);
  });

  it("adds a trend day that has marketing spend and no sales", () => {
    const base = report();
    base.trend = [{ bucket: "2026-11-01", label: "1 Nov", gross: 100, net: 90, orders: 1, hpp: 20, profit: 70 }];
    const next = applyMarketingAllocation(base, [
      { storeName: "Jansen Official Store", periodStart: "2026-11-09", periodEnd: "2026-11-09", spend: 100 },
    ], { from: "2026-11-01", to: "2026-11-19", stores: [], granularity: "day" });
    const quiet = next.trend.find((row) => row.bucket === "2026-11-09");
    expect(quiet).toMatchObject({ gross: 0, net: 0, orders: 0, profit: 0, marketing: 100 });
    expect(next.trend.map((row) => row.bucket)).toEqual(["2026-11-01", "2026-11-09"]);
  });
});
