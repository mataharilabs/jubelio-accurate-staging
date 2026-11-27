import { normName, round2 } from "@/lib/fees/money";
import { SETTLEMENT_MARKER, type FeeDraft, type SalesLine } from "@/lib/fees/types";

export function resolveSku(row: FeeDraft, sales: readonly SalesLine[]): string | null {
  if (row.sku) return row.sku;
  const name = normName(row.productName);
  if (!name) return null;
  const hits = new Set(
    sales
      .filter((line) => line.noPesanan === row.noPesanan && normName(line.productName) === name && line.sku)
      .map((line) => line.sku),
  );
  return hits.size === 1 ? [...hits][0] : null;
}

function weightsFor(orderNo: string, sales: readonly SalesLine[]): { sku: string; weight: number }[] {
  const bySku = new Map<string, { revenue: number; qty: number }>();
  for (const line of sales) {
    if (line.noPesanan !== orderNo || !line.sku) continue;
    const current = bySku.get(line.sku) ?? { revenue: 0, qty: 0 };
    current.revenue += line.revenue;
    current.qty += line.qty;
    bySku.set(line.sku, current);
  }
  const rows = [...bySku.entries()].map(([sku, value]) => ({ sku, ...value })).sort((a, b) => a.sku.localeCompare(b.sku));
  if (!rows.length) return [];
  const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const qty = rows.reduce((sum, row) => sum + row.qty, 0);
  if (revenue !== 0) return rows.map((row) => ({ sku: row.sku, weight: row.revenue }));
  if (qty !== 0) return rows.map((row) => ({ sku: row.sku, weight: row.qty }));
  return rows.map((row) => ({ sku: row.sku, weight: 1 }));
}

/** Last SKU (sorted) absorbs the rounding remainder so the parts sum to the original amount. */
export function splitAmount(amount: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (weights.length === 1) return [round2(amount)];
  const parts = weights.map((weight, index) => {
    if (index === weights.length - 1) return 0;
    const share = total === 0 ? 1 / weights.length : weight / total;
    return round2(amount * share);
  });
  const used = parts.slice(0, -1).reduce((sum, part) => sum + part, 0);
  parts[parts.length - 1] = round2(amount - used);
  return parts;
}

/**
 * Spread order-level fees onto the order's SKUs. Rows that already name a SKU stay as they are.
 * A settlement marker stays on the order so unpaid detection still sees one row.
 */
export function allocateOrderFees(rows: readonly FeeDraft[], sales: readonly SalesLine[]): FeeDraft[] {
  const cache = new Map<string, { sku: string; weight: number }[]>();
  const out: FeeDraft[] = [];
  for (const row of rows) {
    if (row.sku || row.feeName === SETTLEMENT_MARKER) {
      out.push(row);
      continue;
    }
    let parts = cache.get(row.noPesanan);
    if (!parts) {
      parts = weightsFor(row.noPesanan, sales);
      cache.set(row.noPesanan, parts);
    }
    if (parts.length === 0) {
      out.push(row);
      continue;
    }
    const amounts = splitAmount(row.amountRp, parts.map((part) => part.weight));
    parts.forEach((part, index) => {
      out.push({ ...row, sku: part.sku, amountRp: amounts[index] ?? 0, allocated: true });
    });
  }
  return out;
}

export function applySalesLines(rows: readonly FeeDraft[], sales: readonly SalesLine[], allocate: boolean): FeeDraft[] {
  const named = rows.map((row) => ({ ...row, sku: resolveSku(row, sales) }));
  return allocate ? allocateOrderFees(named, sales) : named;
}
