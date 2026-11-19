import type { DuplicateGroup } from "@/lib/marketing/types";

export type Span = {
  id: string;
  platform: string;
  storeName: string;
  periodStart: string;
  periodEnd: string;
};

export function periodsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function duplicateGroups(existing: Span[], incoming: { platform: string; storeName: string; periodStart: string; periodEnd: string }[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const row of existing) {
    const hit = incoming.some((item) =>
      item.platform === row.platform
      && item.storeName.toLowerCase() === row.storeName.toLowerCase()
      && periodsOverlap(item.periodStart, item.periodEnd, row.periodStart, row.periodEnd));
    if (!hit) continue;
    const key = `${row.platform}\u0000${row.storeName.toLowerCase()}`;
    const group = groups.get(key) ?? {
      platform: row.platform,
      storeName: row.storeName,
      count: 0,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      ids: [],
    };
    group.count += 1;
    group.ids.push(row.id);
    if (row.periodStart < group.periodStart) group.periodStart = row.periodStart;
    if (row.periodEnd > group.periodEnd) group.periodEnd = row.periodEnd;
    groups.set(key, group);
  }
  return [...groups.values()];
}
