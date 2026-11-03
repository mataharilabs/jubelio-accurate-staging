export type CostSource = "accurate" | "manual";

export type CostPoint = {
  sku: string;
  costDate: string;
  unitCost: number;
  source: CostSource;
  fetchedAt: string;
};

/** Latest date wins. On the same date, a manual entry wins over Accurate. */
export function effectiveCost(rows: CostPoint[]): CostPoint | null {
  const usable = rows.filter((row) => Number.isFinite(row.unitCost));
  if (!usable.length) return null;
  return [...usable].sort((a, b) => {
    if (a.costDate !== b.costDate) return a.costDate < b.costDate ? 1 : -1;
    if (a.source !== b.source) return a.source === "manual" ? -1 : 1;
    return a.fetchedAt < b.fetchedAt ? 1 : -1;
  })[0];
}

export function grossProfit(net: number, qty: number, unitCost: number | null): number | null {
  if (unitCost == null) return null;
  return net - unitCost * qty;
}

export function hppCoverage(skus: { unitCost: number | null }[]): { skus: number; withHpp: number; percent: number } {
  const total = skus.length;
  const withHpp = skus.filter((row) => row.unitCost != null).length;
  return { skus: total, withHpp, percent: total ? Math.round((1000 * withHpp) / total) / 10 : 0 };
}
