import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";

export type FeeReportRow = Record<string, unknown>;

function num(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function text(value: unknown): string {
  return String(value ?? "");
}

export function feeSheet(kind: string, rows: FeeReportRow[]): Buffer {
  const data = rows.map((row) => {
    if (kind === "affiliate") {
      return {
        "No pesanan": text(row.noPesanan),
        Tanggal: text(row.day),
        Channel: text(row.channel),
        Toko: text(row.storeName),
        "Nama biaya": text(row.feeName),
        Nominal: num(row.amount),
      };
    }
    if (kind === "sku") {
      return {
        Channel: text(row.channel),
        Toko: text(row.storeName),
        SKU: text(row.sku),
        Pesanan: num(row.orders),
        Nominal: num(row.amount),
      };
    }
    return {
      Channel: text(row.channel),
      Toko: text(row.storeName),
      "Grup biaya": text(row.feeGroup),
      Pesanan: num(row.orders),
      Nominal: num(row.amount),
    };
  });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(data), "Biaya");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function safe(value: unknown): string {
  return String(value ?? "").replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]/g, "?");
}

export async function pdfFees(title: string, rows: FeeReportRow[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([842, 595]);
  page.drawText(safe(title), { x: 32, y: 560, size: 16, font: bold, color: rgb(0.12, 0.14, 0.22) });
  page.drawText(safe(`${rows.length} baris`), { x: 32, y: 538, size: 10, font, color: rgb(0.4, 0.44, 0.52) });
  let y = 510;
  for (const row of rows.slice(0, 28)) {
    const line = row.noPesanan
      ? `${text(row.day)}  ${text(row.noPesanan)}  ${text(row.channel)}  ${text(row.storeName)}  ${Math.round(num(row.amount))}`
      : `${text(row.channel)}  ${text(row.storeName)}  ${text(row.feeGroup || row.sku)}  ${Math.round(num(row.amount))}`;
    page.drawText(safe(line).slice(0, 140), { x: 32, y, size: 9, font, color: rgb(0.1, 0.12, 0.18) });
    y -= 16;
    if (y < 40) break;
  }
  return Buffer.from(await doc.save());
}
