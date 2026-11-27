import { parseBlibli } from "@/lib/fees/parse-blibli";
import { parseLazada } from "@/lib/fees/parse-lazada";
import { parsePayments } from "@/lib/fees/parse-payments";
import { parseShopee } from "@/lib/fees/parse-shopee";
import { parseTemplate } from "@/lib/fees/parse-template";
import { parseTiktok } from "@/lib/fees/parse-tiktok";
import type { FeeDraft, FeeGroup, ParsedFees } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

function withPayments(parsed: ParsedFees, book: XLSX.WorkBook): ParsedFees {
  const payments = parsePayments(book);
  if (!payments.length) return { ...parsed, payments: parsed.payments ?? [] };
  const seen = new Set(parsed.orders.map((order) => order.noPesanan));
  const orders = [...parsed.orders];
  for (const row of payments) {
    if (seen.has(row.noPesanan)) continue;
    seen.add(row.noPesanan);
    orders.push({ noPesanan: row.noPesanan });
  }
  return { ...parsed, payments, orders };
}

function emptyTemplate(): ParsedFees {
  return { marketplace: "template", format: "pembayaran", rows: [], orders: [], readCount: 0, payments: [] };
}

export function parseFeeWorkbook(book: XLSX.WorkBook): ParsedFees {
  const names = new Set(book.SheetNames);
  let parsed: ParsedFees;
  if (names.has("Penghasilan")) parsed = parseShopee(book);
  else if (names.has("Transaction Overview")) parsed = parseLazada(book);
  else if (names.has("Detail pesanan")) parsed = parseTiktok(book);
  else if (names.has("SSR Summary")) parsed = parseBlibli(book);
  else if (names.has("Pembayaran") && !book.SheetNames.some((name) => name !== "Pembayaran" && name !== "Petunjuk")) parsed = emptyTemplate();
  else parsed = parseTemplate(book);
  return withPayments(parsed, book);
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
