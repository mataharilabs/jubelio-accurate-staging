import type { MarketingRecord } from "@/lib/marketing/types";

export function filterMarketingRows(rows: MarketingRecord[], filter: { store?: string; platform?: string; source?: string; q?: string }): MarketingRecord[] {
  const q = (filter.q ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.store && row.storeName !== filter.store) return false;
    if (filter.platform && row.platform !== filter.platform) return false;
    if (filter.source && row.source !== filter.source) return false;
    if (!q) return true;
    return `${row.campaign} ${row.storeName} ${row.platform} ${row.sourceFile} ${row.createdBy}`.toLowerCase().includes(q);
  });
}
