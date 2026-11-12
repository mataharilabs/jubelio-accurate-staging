import type { BundleComponent, BundleDefinition } from "@/lib/db/types";

export type WeightPart = { sku: string; qty: number; weightPct: number };

export type AllocatedPart = WeightPart & { amount: number; unitPrice: number };

/** HPP of an exploded component line stays the component cost times its quantity. */
export function componentExtendedCost(unitCost: number, qty: number): number {
  return unitCost * qty;
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Percentage weights for a paket. Qty mode splits by component quantity.
 * Equal mode (and qty mode when a qty is missing) splits evenly.
 * The last component absorbs the rounding difference so the total is 100.
 */
export function splitWeights(rows: { qty: number }[], mode: "qty" | "equal" = "qty"): number[] {
  if (!rows.length) return [];
  const byQty = mode === "qty" && rows.every((row) => row.qty > 0);
  const basis = rows.map((row) => (byQty ? row.qty : 1));
  const total = basis.reduce((sum, value) => sum + value, 0);
  let used = 0;
  return basis.map((value, index) => {
    if (index === basis.length - 1) return round4(100 - used);
    const pct = round4((100 * value) / total);
    used = round4(used + pct);
    return pct;
  });
}

export function weightTotalError(rows: { sku?: string; qty?: number; weightPct: number }[]): string | null {
  if (!rows.length) return "Paket harus punya minimal satu komponen.";
  const seen = new Set<string>();
  for (const row of rows) {
    const sku = row.sku?.trim() ?? "";
    if (row.sku != null && !sku) return "SKU komponen wajib diisi.";
    if (sku) {
      if (seen.has(sku)) return `SKU ${sku} dobel di paket yang sama.`;
      seen.add(sku);
    }
    if (row.qty != null && !(row.qty > 0)) return "Qty komponen harus lebih dari 0.";
    if (!Number.isFinite(row.weightPct) || row.weightPct < 0) return "Bobot tidak boleh negatif.";
  }
  const total = round4(rows.reduce((sum, row) => sum + row.weightPct, 0));
  if (Math.abs(total - 100) > 0.0001) return `Total bobot harus tepat 100%. Sekarang ${total}%.`;
  return null;
}

/**
 * Split a bundle line amount by component percentages.
 * Amounts are rounded to `places` decimal digits (default: sen).
 * The last component receives the remainder so the parts sum to the line amount
 * after that same rounding.
 */
export function allocateBundleAmounts(lineAmount: number, components: WeightPart[], places = 2): AllocatedPart[] {
  if (!components.length) return [];
  const weight = components.reduce((sum, row) => sum + row.weightPct, 0);
  const factor = 10 ** places;
  const target = Math.round(lineAmount * factor);
  if (!(weight > 0) || !Number.isFinite(lineAmount)) {
    return components.map((row) => ({ ...row, amount: 0, unitPrice: 0 }));
  }
  let used = 0;
  return components.map((row, index) => {
    const last = index === components.length - 1;
    const units = last ? target - used : Math.round(lineAmount * (row.weightPct / weight) * factor);
    used += units;
    const amount = units / factor;
    return {
      sku: row.sku,
      qty: row.qty,
      weightPct: row.weightPct,
      amount,
      unitPrice: row.qty ? amount / row.qty : 0,
    };
  });
}

export function parentFromBundleKey(bundleKey: string, componentSku: string): string | null {
  const key = bundleKey.trim();
  const sku = componentSku.trim();
  const suffix = `-${sku}`;
  if (!sku || !key.endsWith(suffix) || key.length <= suffix.length) return null;
  return key.slice(0, -suffix.length);
}

/** Longest known SKU that is a hyphen-suffix of the legacy bundle key. */
export function splitLegacyBundleKey(bundleKey: string, knownSkus: readonly string[]): { bundleSku: string; componentSku: string } | null {
  const key = bundleKey.trim();
  let best: string | null = null;
  for (const sku of knownSkus) {
    const component = sku.trim();
    if (!component || component.length >= key.length) continue;
    if (!key.endsWith(`-${component}`)) continue;
    if (!best || component.length > best.length) best = component;
  }
  if (!best) return null;
  return { bundleSku: key.slice(0, -(best.length + 1)), componentSku: best };
}

/**
 * Legacy bobot rows have no component qty. Group by a known SKU suffix when possible
 * and assign an equal split (qty unknown, so proportional-by-qty is the same).
 * A key that cannot be split becomes its own paket at 100%.
 */
export function bundlesFromLegacyWeights(
  rows: { bundleKey: string }[],
  knownSkus: readonly string[],
): { bundleSku: string; components: WeightPart[] }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = row.bundleKey.trim();
    if (!key) continue;
    const split = splitLegacyBundleKey(key, knownSkus);
    const bundleSku = split?.bundleSku ?? key;
    const sku = split?.componentSku ?? key;
    const components = groups.get(bundleSku) ?? new Map<string, number>();
    if (!components.has(sku)) components.set(sku, 1);
    groups.set(bundleSku, components);
  }
  return [...groups.entries()].map(([bundleSku, components]) => {
    const parts = [...components.entries()].map(([sku, qty]) => ({ sku, qty }));
    const weights = splitWeights(parts, "equal");
    return {
      bundleSku,
      components: parts.map((part, index) => ({ ...part, weightPct: weights[index] ?? 0 })),
    };
  });
}

export function groupBundles(rows: BundleComponent[]): BundleDefinition[] {
  const map = new Map<string, BundleComponent[]>();
  for (const row of rows) {
    const list = map.get(row.bundleSku) ?? [];
    list.push(row);
    map.set(row.bundleSku, list);
  }
  return [...map.entries()]
    .map(([bundleSku, components]) => {
      const ordered = components.slice().sort((a, b) => a.position - b.position || a.sku.localeCompare(b.sku, "id"));
      const pending = ordered.some((row) => row.confirmedAt === null);
      const confirmed = ordered.map((row) => row.confirmedAt).filter((value): value is string => Boolean(value));
      const updated = ordered.map((row) => row.updatedAt).filter(Boolean).sort();
      return {
        bundleSku,
        confirmedAt: pending ? null : confirmed.sort().at(-1) ?? null,
        updatedAt: updated.at(-1) ?? null,
        components: ordered.map((row) => ({ sku: row.sku, qty: row.qty, weightPct: row.weightPct })),
      };
    })
    .sort((a, b) => a.bundleSku.localeCompare(b.bundleSku, "id"));
}

export function componentWeightMap(rows: BundleComponent[]): Map<string, WeightPart[]> | null {
  if (!rows.length) return null;
  const grouped = groupBundles(rows);
  return new Map(grouped.map((bundle) => [bundle.bundleSku, bundle.components.map((row) => ({ ...row }))]));
}
