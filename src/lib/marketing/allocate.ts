import type { DashboardQuery, DashboardReport, GroupRow } from "@/lib/db/types";
import { bucketOf } from "@/lib/domain/aggregate";
import { inclusiveDays } from "@/lib/marketing/dates";

export type SpendSlice = {
  storeName: string;
  periodStart: string;
  periodEnd: string;
  spend: number;
};

export function overlapFactor(periodStart: string, periodEnd: string, from: string | null, to: string | null): number {
  const start = from && from > periodStart ? from : periodStart;
  const end = to && to < periodEnd ? to : periodEnd;
  if (end < start) return 0;
  const total = inclusiveDays(periodStart, periodEnd);
  if (total <= 0) return 0;
  return inclusiveDays(start, end) / total;
}

function nextIso(day: string): string {
  const stamp = new Date(`${day}T00:00:00Z`);
  stamp.setUTCDate(stamp.getUTCDate() + 1);
  return stamp.toISOString().slice(0, 10);
}

/** Profit shown on Dashboard Toko: revenue bersih − HPP − biaya platform − marketing. */
export function storeProfit(net: number, hpp: number, fee: number, marketing: number): number {
  return net - hpp - fee - marketing;
}

export function applyMarketingAllocation(report: DashboardReport, spends: SpendSlice[], query: Pick<DashboardQuery, "from" | "to" | "stores" | "granularity">): DashboardReport {
  const wanted = new Set((query.stores ?? []).map((store) => store.toLowerCase()));
  const byStore = new Map<string, { name: string; amount: number }>();
  const byBucket = new Map<string, number>();
  let total = 0;
  for (const row of spends) {
    if (wanted.size && !wanted.has(row.storeName.toLowerCase())) continue;
    const factor = overlapFactor(row.periodStart, row.periodEnd, query.from, query.to);
    if (factor <= 0) continue;
    total += row.spend * factor;
    const key = row.storeName.toLowerCase();
    const entry = byStore.get(key) ?? { name: row.storeName, amount: 0 };
    entry.amount += row.spend * factor;
    byStore.set(key, entry);
    const periodDays = inclusiveDays(row.periodStart, row.periodEnd);
    if (!periodDays || !query.granularity) continue;
    const daily = row.spend / periodDays;
    let day = query.from && query.from > row.periodStart ? query.from : row.periodStart;
    const end = query.to && query.to < row.periodEnd ? query.to : row.periodEnd;
    while (day <= end) {
      const bucket = bucketOf(day, query.granularity);
      if (bucket) byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + daily);
      day = nextIso(day);
    }
  }
  const stores: GroupRow[] = report.stores.map((store) => {
    const hit = byStore.get(store.key.toLowerCase());
    const marketing = Math.round((hit?.amount ?? 0) * 100) / 100;
    if (hit) byStore.delete(store.key.toLowerCase());
    return { ...store, marketing };
  });
  for (const { name, amount } of byStore.values()) {
    const marketing = Math.round(amount * 100) / 100;
    if (!marketing) continue;
    stores.push({ key: name, gross: 0, net: 0, hpp: 0, profit: 0, qty: 0, orders: 0, marketing });
  }
  return {
    ...report,
    kpis: { ...report.kpis, marketing: Math.round(total * 100) / 100 },
    stores,
    trend: report.trend.map((row) => ({ ...row, marketing: Math.round((byBucket.get(row.bucket) ?? 0) * 100) / 100 })),
  };
}
