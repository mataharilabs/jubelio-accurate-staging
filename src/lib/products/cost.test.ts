import { describe, expect, it } from "vitest";
import { accurateTransDate, costForMonth, encodePending, grossProfit, hppCoverage, monthStart, syncWork, type CostPoint } from "@/lib/products/cost";

const rows: CostPoint[] = [
  { sku: "A", periodMonth: "2026-10-01", unitCost: 1000, source: "accurate", fetchedAt: "2026-10-01T00:00:00Z" },
  { sku: "A", periodMonth: "2026-11-01", unitCost: 1500, source: "accurate", fetchedAt: "2026-11-01T00:00:00Z" },
  { sku: "A", periodMonth: "2026-11-01", unitCost: 900, source: "manual", fetchedAt: "2026-11-01T01:00:00Z" },
];

describe("monthly HPP", () => {
  it("uses that month's snapshot, and lets manual win over Accurate for the same month", () => {
    const october = costForMonth(rows, "2026-10-18");
    const november = costForMonth(rows, "2026-11-01");
    expect(october.cost?.unitCost).toBe(1000);
    expect(october.carried).toBe(false);
    expect(november.cost?.unitCost).toBe(900);
    expect(november.cost?.source).toBe("manual");
    expect(november.carried).toBe(false);
    expect(grossProfit(10000, 4, november.cost?.unitCost ?? null)).toBe(6400);
    expect(accurateTransDate("2026-10-01")).toBe("01/10/2026");
    expect(accurateTransDate("2026-11-04")).toBe("01/11/2026");
    expect(monthStart("2026-11-04")).toBe("2026-11-01");
  });

  it("falls back to the most recent earlier month and says so", () => {
    const earlier = costForMonth(rows.filter((row) => row.periodMonth === "2026-10-01"), "2026-11-04");
    expect(earlier.cost?.unitCost).toBe(1000);
    expect(earlier.carried).toBe(true);
    expect(costForMonth([], "2026-11-01")).toEqual({ cost: null, carried: false });
    expect(grossProfit(5000, 2, null)).toBeNull();
  });

  it("does not let a later month replace an earlier month's sales", () => {
    const chosen = costForMonth([
      { sku: "A", periodMonth: "2026-10-01", unitCost: 900, source: "manual", fetchedAt: "2026-10-01T00:00:00Z" },
      { sku: "A", periodMonth: "2026-11-01", unitCost: 1200, source: "accurate", fetchedAt: "2026-11-03T10:00:00Z" },
    ], "2026-10-31");
    expect(chosen.cost?.source).toBe("manual");
    expect(chosen.cost?.unitCost).toBe(900);
    expect(chosen.carried).toBe(false);
  });

  it("counts SKUs that still have no HPP", () => {
    expect(hppCoverage([{ unitCost: 1 }, { unitCost: null }, { unitCost: 2 }])).toEqual({ skus: 3, withHpp: 2, percent: 66.7 });
  });

  it("backfills October and November, then only fills gaps unless refresh is asked", () => {
    const skus = [
      { sku: "A", accurateFound: "true" as const },
      { sku: "B", accurateFound: "unknown" as const },
      { sku: "C", accurateFound: "false" as const },
    ];
    const covered = [{ sku: "A", periodMonth: "2026-10-01" }, { sku: "A", periodMonth: "2026-11-01" }];
    const cron = syncWork("2026-11-04", skus, covered, "cron");
    expect(cron.map(encodePending)).toEqual(["2026-10-01|B", "2026-11-01|B"]);
    const gaps = syncWork("2026-11-04", skus, covered, "gaps");
    expect(gaps.map((row) => row.sku).sort()).toEqual(["B", "B", "C", "C"]);
    const refresh = syncWork("2026-11-04", skus, covered, "refresh");
    expect(refresh.filter((row) => row.periodMonth === "2026-11-01").map((row) => row.sku)).toEqual(["A", "B", "C"]);
    expect(syncWork("2026-12-01", [{ sku: "A", accurateFound: "true" }], covered, "cron").map(encodePending)).toEqual(["2026-12-01|A"]);
  });
});
