import { parseAmount } from "@/lib/fees/money";
import { cell, findHeader, normHeader, sheetMatrix, textCell } from "@/lib/fees/sheets";
import { isFeeGroup, reducesProfit, type FeeDraft, type FeeGroup, type ParsedFees } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

const ALIASES: Record<string, FeeGroup> = {
  komisi: "Komisi",
  "biaya layanan/program": "Biaya layanan/program",
  "biaya layanan": "Biaya layanan/program",
  layanan: "Biaya layanan/program",
  "biaya pembayaran": "Biaya pembayaran",
  pembayaran: "Biaya pembayaran",
  "biaya proses pesanan": "Biaya proses pesanan",
  proses: "Biaya proses pesanan",
  "ongkir ditanggung penjual": "Ongkir ditanggung penjual",
  ongkir: "Ongkir ditanggung penjual",
  "komisi afiliasi": "Komisi afiliasi",
  afiliasi: "Komisi afiliasi",
  pajak: "Pajak",
  "lain-lain": "Lain-lain",
  lain: "Lain-lain",
};

export function feeGroupFromLabel(value: string): FeeGroup | null {
  const key = normHeader(value);
  if (isFeeGroup(value.trim())) return value.trim() as FeeGroup;
  return ALIASES[key] ?? null;
}

/** Standard template: no_pesanan, sku, grup biaya, nama biaya, nominal, persen. Nominal is already a seller cost. */
export function parseTemplate(book: XLSX.WorkBook): ParsedFees {
  const name = book.SheetNames[0];
  if (!name) throw new Error("Template kosong.");
  const matrix = sheetMatrix(book, name);
  const header = findHeader(matrix, ["no_pesanan", "nominal"]);
  if (!header) throw new Error("Template butuh kolom no_pesanan dan nominal.");
  const columns = header.columns;
  const rows: FeeDraft[] = [];
  const orders = new Map<string, { noPesanan: string }>();
  let readCount = 0;
  for (let index = header.index + 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const no = textCell(values, columns, "no_pesanan");
    if (!no) continue;
    readCount += 1;
    const group = feeGroupFromLabel(textCell(values, columns, "grup_biaya") || textCell(values, columns, "fee group") || textCell(values, columns, "grup biaya"));
    if (!group) throw new Error(`Grup biaya tidak dikenal pada pesanan ${no}.`);
    const amount = parseAmount(cell(values, columns, "nominal"));
    const pctRaw = textCell(values, columns, "persen");
    const pct = pctRaw ? parseAmount(pctRaw) : null;
    orders.set(no, { noPesanan: no });
    rows.push({
      noPesanan: no,
      sku: textCell(values, columns, "sku") || null,
      feeGroup: group,
      feeName: textCell(values, columns, "nama_biaya") || textCell(values, columns, "fee name") || group,
      amountRp: amount,
      pct: pct == null || Number.isNaN(pct) ? null : pct,
      base: null,
      reducesProfit: reducesProfit(group),
      allocated: false,
      marketplace: "template",
    });
  }
  return { marketplace: "template", format: "template", rows, orders: [...orders.values()], readCount };
}
