import type { OrderQuery } from "@/lib/db/types";
import { needsAccurateSync } from "@/lib/domain/phase3";

export function matchesOrderScope(input: { channel: string; storeName: string; dataStatus?: string | null; contentUpdatedAt?: string | null; syncedAt?: string | null }, query: OrderQuery): boolean {
  if (query.channels?.length && !query.channels.includes(input.channel)) return false;
  if (query.stores?.length && !query.stores.includes(input.storeName)) return false;
  if (query.sync === "need" || query.sync === "done") {
    const need = needsAccurateSync({ dataStatus: input.dataStatus, contentUpdatedAt: input.contentUpdatedAt, syncedAt: input.syncedAt });
    if (query.sync === "need" && !need) return false;
    if (query.sync === "done" && need) return false;
  }
  return true;
}

export function matchesOrderFilter(input: { day: string; status: string; noPesanan: string; sku: string; productName: string; customerName: string; storeName: string; city: string; channel: string }, query: OrderQuery): boolean {
  if (query.day && input.day !== query.day) return false;
  if (query.from && input.day < query.from) return false;
  if (query.to && input.day > query.to) return false;
  if (query.statuses?.length && !query.statuses.includes(input.status)) return false;
  const q = query.q.trim().toLowerCase();
  if (!q) return true;
  return [input.noPesanan, input.sku, input.productName, input.customerName, input.storeName, input.city, input.channel].join(" ").toLowerCase().includes(q);
}
