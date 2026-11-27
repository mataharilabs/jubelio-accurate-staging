import { parseAmount } from "@/lib/fees/money";
import { cell, findHeader, sheetMatrix, textCell } from "@/lib/fees/sheets";
import type { PaymentDraft } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

function isoDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const utc = new Date(Date.UTC(1899, 11, 30 + Math.floor(value)));
    return utc.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const slash = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  return "";
}

/** Sheet "Pembayaran": no_pesanan, tanggal_bayar, nominal, metode, catatan. */
export function parsePayments(book: XLSX.WorkBook): PaymentDraft[] {
  if (!book.SheetNames.includes("Pembayaran")) return [];
  const matrix = sheetMatrix(book, "Pembayaran");
  const header = findHeader(matrix, ["no_pesanan", "nominal"]);
  if (!header) throw new Error("Sheet Pembayaran butuh kolom no_pesanan dan nominal.");
  const columns = header.columns;
  const rows: PaymentDraft[] = [];
  for (let index = header.index + 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const no = textCell(values, columns, "no_pesanan");
    if (!no) continue;
    const amount = parseAmount(cell(values, columns, "nominal"));
    if (!Number.isFinite(amount)) continue;
    const paidAt = isoDate(cell(values, columns, "tanggal_bayar")) || new Date().toISOString().slice(0, 10);
    rows.push({
      noPesanan: no,
      paidAt,
      amountRp: amount,
      method: textCell(values, columns, "metode"),
      note: textCell(values, columns, "catatan"),
    });
  }
  return rows;
}
