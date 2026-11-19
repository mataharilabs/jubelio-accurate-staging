import type { DashboardQuery, DashboardReport, GroupRow } from "@/lib/db/types";
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

export function applyMarketingAllocation(report: DashboardReport, spends: SpendSlice[], query: Pick<DashboardQuery, "from" | "to" | "stores">): DashboardReport {
  const wanted = new Set((query.stores ?? []).map((store) => store.toLowerCase()));
  const byStore = new Map<string, number>();
  let total = 0;
  for (const row of spends) {
    if (wanted.size && !wanted.has(row.storeName.toLowerCase())) continue;
    const factor = overlapFactor(row.periodStart, row.periodEnd, query.from, query.to);
    if (factor <= 0) continue;
    const part = Math.round(row.spend * factor * 100) / 100;
    total += part;
    byStore.set(row.storeName, (byStore.get(row.storeName) ?? 0) + part);
  }
  const stores: GroupRow[] = report.stores.map((store) => {
    const hit = [...byStore.keys()].find((key) => key.toLowerCase() === store.key.toLowerCase());
    const marketing = hit ? byStore.get(hit) ?? 0 : 0;
    if (hit) byStore.delete(hit);
    return { ...store, marketing };
  });
  for (const [key, marketing] of byStore) {
    if (!marketing) continue;
    stores.push({ key, gross: 0, net: 0, hpp: 0, profit: 0, qty: 0, orders: 0, marketing });
  }
  return {
    ...report,
    kpis: { ...report.kpis, marketing: Math.round(total * 100) / 100 },
    stores,
  };
}
