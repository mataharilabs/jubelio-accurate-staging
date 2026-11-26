import type { FeeDraft } from "@/lib/fees/types";

/** Keep every fee of an order in the same request so a retry cannot delete a partial save. */
export function chunkFeeRows(rows: readonly FeeDraft[], limit = 700): FeeDraft[][] {
  const groups = new Map<string, FeeDraft[]>();
  for (const row of rows) {
    const list = groups.get(row.noPesanan) ?? [];
    list.push(row);
    groups.set(row.noPesanan, list);
  }
  const chunks: FeeDraft[][] = [];
  let current: FeeDraft[] = [];
  for (const list of groups.values()) {
    if (current.length && current.length + list.length > limit) {
      chunks.push(current);
      current = [];
    }
    current.push(...list);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function keepMatched(rows: readonly FeeDraft[], matched: readonly { input: string; resolved: string }[]): FeeDraft[] {
  const resolved = new Map(matched.map((item) => [item.input, item.resolved]));
  const kept: FeeDraft[] = [];
  for (const row of rows) {
    const next = resolved.get(row.noPesanan);
    if (!next) continue;
    kept.push(next === row.noPesanan ? row : { ...row, noPesanan: next });
  }
  return kept;
}
