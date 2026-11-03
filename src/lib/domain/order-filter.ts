import type { OrderQuery } from "@/lib/db/types";

export function matchesOrderFilter(input: { day: string; status: string; noPesanan: string; sku: string; productName: string; customerName: string; storeName: string; city: string; channel: string }, query: OrderQuery): boolean {
  if (query.day && input.day !== query.day) return false;
  if (query.from && input.day < query.from) return false;
  if (query.to && input.day > query.to) return false;
  if (query.statuses?.length && !query.statuses.includes(input.status)) return false;
  const q = query.q.trim().toLowerCase();
  if (!q) return true;
  return [input.noPesanan, input.sku, input.productName, input.customerName, input.storeName, input.city, input.channel].join(" ").toLowerCase().includes(q);
}
