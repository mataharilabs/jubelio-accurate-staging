import { costFromDeduction, parseAmount, percentOf } from "@/lib/fees/money";
import { cell, findHeader, sheetMatrix, textCell } from "@/lib/fees/sheets";
import { SETTLEMENT_MARKER, reducesProfit, type FeeDraft, type FeeGroup, type ParsedFees } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

const GROUPS: Record<string, FeeGroup> = {
  commission: "Komisi",
  "payment fee": "Biaya pembayaran",
  "spa program fee": "Biaya layanan/program",
  "free shipping max fee": "Biaya layanan/program",
  "order processing fee": "Biaya proses pesanan",
  "withholding tax - pit": "Pajak",
};

const SKIP = new Set(["item price credit"]);

/** Lazada Transaction Overview. Amount is VAT-inclusive; a negative amount is a cost. */
export function parseLazada(book: XLSX.WorkBook): ParsedFees {
  const matrix = sheetMatrix(book, "Transaction Overview");
  const header = findHeader(matrix, ["Fee Name", "Amount", "Order No.", "Seller SKU"]);
  if (!header) throw new Error("File Lazada tidak punya kolom Fee Name dan Order No.");
  const columns = header.columns;
  type Item = { no: string; sku: string; fees: { name: string; fileAmount: number }[]; price: number };
  const items = new Map<string, Item>();
  let readCount = 0;
  for (let index = header.index + 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const name = textCell(values, columns, "Fee Name");
    const no = textCell(values, columns, "Order No.");
    if (!name || !no) continue;
    readCount += 1;
    const key = `${no} ${textCell(values, columns, "Order Item No.") || textCell(values, columns, "Seller SKU")}`;
    const item = items.get(key) ?? { no, sku: textCell(values, columns, "Seller SKU"), fees: [], price: 0 };
    const fileAmount = parseAmount(cell(values, columns, "Amount"));
    if (SKIP.has(name.toLowerCase())) item.price += fileAmount;
    else item.fees.push({ name, fileAmount });
    items.set(key, item);
  }
  const rows: FeeDraft[] = [];
  const orders = new Map<string, { noPesanan: string }>();
  for (const item of items.values()) {
    orders.set(item.no, { noPesanan: item.no });
    for (const fee of item.fees) {
      const group = GROUPS[fee.name.toLowerCase()] ?? "Lain-lain";
      const amount = costFromDeduction(fee.fileAmount);
      if (Math.abs(amount) < 0.005) continue;
      const priced = group !== "Pajak" && group !== "Biaya proses pesanan" && item.price > 0;
      rows.push({
        noPesanan: item.no,
        sku: item.sku || null,
        feeGroup: group,
        feeName: fee.name,
        amountRp: amount,
        pct: priced ? percentOf(amount, item.price) : null,
        base: priced ? "Item Price Credit" : null,
        reducesProfit: reducesProfit(group),
        allocated: false,
        marketplace: "lazada",
      });
    }
  }
  for (const order of orders.values()) {
    if (!rows.some((row) => row.noPesanan === order.noPesanan)) {
      rows.push({
        noPesanan: order.noPesanan,
        sku: null,
        feeGroup: "Lain-lain",
        feeName: SETTLEMENT_MARKER,
        amountRp: 0,
        pct: null,
        base: null,
        reducesProfit: false,
        allocated: false,
        marketplace: "lazada",
      });
    }
  }
  return { marketplace: "lazada", format: "transaction-overview", rows, orders: [...orders.values()], readCount };
}
