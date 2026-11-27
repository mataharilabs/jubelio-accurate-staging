import { parseAmount, percentOf } from "@/lib/fees/money";
import { cell, findHeader, sheetMatrix, textCell } from "@/lib/fees/sheets";
import { SETTLEMENT_MARKER, reducesProfit, type FeeDraft, type ParsedFees } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

const MARGIN: { name: string; group: FeeDraft["feeGroup"] }[] = [
  { name: "Regular Margin", group: "Komisi" },
  { name: "Special Margin", group: "Komisi" },
  { name: "Add On Margin", group: "Biaya layanan/program" },
  { name: "Biaya transaksi (Transaction fee)", group: "Biaya pembayaran" },
  { name: "PPH 23 (WHT 23)", group: "Pajak" },
  { name: "Biaya pengiriman Seller (Seller shipping fee)", group: "Ongkir ditanggung penjual" },
];

function digits(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text === "-") return "";
  if (/^\d+(\.0+)?$/.test(text)) return text.replace(/\.0+$/, "");
  const amount = parseAmount(value);
  if (Number.isFinite(amount) && amount > 0 && Math.abs(amount - Math.round(amount)) < 1e-6) return String(Math.round(amount));
  return /^\d+$/.test(text) ? text : "";
}

/** Blibli SSR Summary. One Jubelio order is Order ID + Order item ID. */
export function parseBlibli(book: XLSX.WorkBook): ParsedFees {
  const matrix = sheetMatrix(book, "SSR Summary");
  const header = findHeader(matrix, ["Nomor pesanan (Order ID)", "Nomor item pesanan (Order item ID)", "Regular Margin"]);
  if (!header) throw new Error("Sheet SSR Summary tidak dikenali.");
  const columns = header.columns;
  const skuByItem = new Map<string, string>();
  for (let index = header.index + 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const orderId = digits(cell(values, columns, "Nomor pesanan (Order ID)"));
    const itemId = digits(cell(values, columns, "Nomor item pesanan (Order item ID)"));
    const sku = textCell(values, columns, "Seller SKU");
    if (orderId && itemId && sku) skuByItem.set(`${orderId}-${itemId}`, sku);
  }
  const rows: FeeDraft[] = [];
  const orders = new Map<string, { noPesanan: string; orderId: string }>();
  let readCount = 0;
  for (let index = header.index + 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const orderId = digits(cell(values, columns, "Nomor pesanan (Order ID)"));
    const itemId = digits(cell(values, columns, "Nomor item pesanan (Order item ID)"));
    if (!orderId) continue;
    readCount += 1;
    const no = itemId ? `${orderId}-${itemId}` : orderId;
    orders.set(no, { noPesanan: no, orderId });
    const transaction = textCell(values, columns, "Transaksi (Transaction)");
    const sku = textCell(values, columns, "Seller SKU") || skuByItem.get(no) || null;
    const total = parseAmount(cell(values, columns, "Total"));
    const taxRow = /pph|pajak/i.test(transaction);
    if (!taxRow) {
      for (const column of MARGIN) {
        const amount = parseAmount(cell(values, columns, column.name));
        if (Math.abs(amount) < 0.005) continue;
        const priced = total > 0 && (column.group === "Komisi" || column.group === "Biaya layanan/program");
        rows.push({
          noPesanan: no,
          orderId,
          sku,
          feeGroup: column.group,
          feeName: column.name,
          amountRp: amount,
          pct: priced ? percentOf(amount, total) : null,
          base: priced ? "Total" : null,
          reducesProfit: reducesProfit(column.group),
          allocated: false,
          marketplace: "blibli",
        });
      }
    } else {
      const payment = parseAmount(cell(values, columns, "Total pembayaran (Total payment)"));
      const amount = payment < 0 ? -payment : payment;
      if (Math.abs(amount) >= 0.005) {
        rows.push({
          noPesanan: no,
          orderId,
          sku,
          feeGroup: "Pajak",
          feeName: transaction,
          amountRp: amount,
          pct: null,
          base: null,
          reducesProfit: false,
          allocated: false,
          marketplace: "blibli",
        });
      }
    }
  }
  for (const order of orders.values()) {
    if (!rows.some((row) => row.noPesanan === order.noPesanan)) {
      rows.push({
        noPesanan: order.noPesanan,
        orderId: order.orderId,
        sku: null,
        feeGroup: "Lain-lain",
        feeName: SETTLEMENT_MARKER,
        amountRp: 0,
        pct: null,
        base: null,
        reducesProfit: false,
        allocated: false,
        marketplace: "blibli",
      });
    }
  }
  return { marketplace: "blibli", format: "ssr", rows, orders: [...orders.values()], readCount };
}
