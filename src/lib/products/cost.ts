export type CostSource = "accurate" | "manual";

export type CostPoint = {
  sku: string;
  periodMonth: string;
  unitCost: number;
  source: CostSource;
  fetchedAt: string;
};

export type CostChoice = { cost: CostPoint | null; carried: boolean };

/** First sync also snapshots these months. Sales history starts in October 2026. */
export const HPP_BACKFILL_MONTHS = ["2026-10-01", "2026-11-01"];

export function monthStart(day: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(day);
  if (!match) return day;
  return `${match[1]}-${match[2]}-01`;
}

/** Accurate transDate is dd/MM/yyyy. A November snapshot asks for 01/11/2026. */
export function accurateTransDate(periodMonth: string): string {
  const [year, month, day] = monthStart(periodMonth).split("-");
  return `${day}/${month}/${year}`;
}

/** Manual wins over Accurate for the same month. An earlier month is used only when this month has no row. */
export function costForMonth(rows: CostPoint[], periodMonth: string): CostChoice {
  const month = monthStart(periodMonth);
  const usable = rows.filter((row) => row.periodMonth <= month && Number.isFinite(row.unitCost));
  if (!usable.length) return { cost: null, carried: false };
  const chosen = [...usable].sort((a, b) => {
    if (a.periodMonth !== b.periodMonth) return a.periodMonth < b.periodMonth ? 1 : -1;
    if (a.source !== b.source) return a.source === "manual" ? -1 : 1;
    return a.fetchedAt < b.fetchedAt ? 1 : -1;
  })[0];
  return { cost: chosen, carried: chosen.periodMonth < month };
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

export type SkuCostState = { sku: string; accurateFound: "true" | "false" | "unknown" };

export function snapshotMonths(today: string): string[] {
  const current = monthStart(today);
  const months = HPP_BACKFILL_MONTHS.filter((month) => month <= current);
  if (!months.includes(current)) months.push(current);
  return months;
}

/**
 * cron: fill months that have no row, and skip SKUs Accurate already said are missing.
 * gaps: the manual button, same fill but it retries SKUs that were missing.
 * refresh: re-read every SKU for the current month. Older months still only fill gaps.
 */
export function syncWork(
  today: string,
  skus: SkuCostState[],
  covered: { sku: string; periodMonth: string }[],
  mode: "cron" | "gaps" | "refresh",
): { periodMonth: string; sku: string }[] {
  const current = monthStart(today);
  const has = new Set(covered.map((row) => `${row.periodMonth}|${row.sku}`));
  const work: { periodMonth: string; sku: string }[] = [];
  for (const periodMonth of snapshotMonths(today)) {
    for (const sku of skus) {
      const refreshThisMonth = mode === "refresh" && periodMonth === current;
      if (!refreshThisMonth && has.has(`${periodMonth}|${sku.sku}`)) continue;
      if (!refreshThisMonth && mode === "cron" && sku.accurateFound === "false") continue;
      work.push({ periodMonth, sku: sku.sku });
    }
  }
  return work;
}

export function encodePending(item: { periodMonth: string; sku: string }): string {
  return `${monthStart(item.periodMonth)}|${item.sku}`;
}

export function decodePending(value: string): { periodMonth: string; sku: string } | null {
  const split = value.indexOf("|");
  if (split < 8) return null;
  const periodMonth = monthStart(value.slice(0, split));
  const sku = value.slice(split + 1).trim();
  if (!sku) return null;
  return { periodMonth, sku };
}
