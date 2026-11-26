import { parseBlibli } from "@/lib/fees/parse-blibli";
import { parseLazada } from "@/lib/fees/parse-lazada";
import { parseShopee } from "@/lib/fees/parse-shopee";
import { parseTemplate } from "@/lib/fees/parse-template";
import { parseTiktok } from "@/lib/fees/parse-tiktok";
import type { FeeDraft, FeeGroup, ParsedFees } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

export function parseFeeWorkbook(book: XLSX.WorkBook): ParsedFees {
  const names = new Set(book.SheetNames);
  if (names.has("Penghasilan")) return parseShopee(book);
  if (names.has("Transaction Overview")) return parseLazada(book);
  if (names.has("Detail pesanan")) return parseTiktok(book);
  if (names.has("SSR Summary")) return parseBlibli(book);
  return parseTemplate(book);
}

export type FeeSummary = {
  orders: number;
  rows: number;
  total: number;
  groups: { group: FeeGroup; count: number; amount: number }[];
};

export function summarizeFees(rows: readonly FeeDraft[]): FeeSummary {
  const groups = new Map<FeeGroup, { count: number; amount: number }>();
  const orders = new Set<string>();
  let total = 0;
  for (const row of rows) {
    orders.add(row.noPesanan);
    if (Math.abs(row.amountRp) < 0.005) continue;
    total += row.amountRp;
    const current = groups.get(row.feeGroup) ?? { count: 0, amount: 0 };
    current.count += 1;
    current.amount += row.amountRp;
    groups.set(row.feeGroup, current);
  }
  return {
    orders: orders.size,
    rows: rows.length,
    total,
    groups: [...groups.entries()].map(([group, value]) => ({ group, count: value.count, amount: value.amount })),
  };
}
