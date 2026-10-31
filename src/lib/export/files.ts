import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";
import type { DashboardReport, OrderPageRow, SyncBatch, SyncBatchItem, SyncReviewRow } from "@/lib/db/types";
import { dayLabel } from "@/lib/domain/aggregate";

const COLS = [
  "Tanggal Pesanan",
  "No Pesanan",
  "Channel",
  "Store Name",
  "SKU",
  "Qty",
  "Unit Price",
  "Sub Total",
  "Total Nilai Pesanan",
  "Total Diskon",
  "Unit Diskon",
  "Revenue per Unit",
  "Customer Name",
  "Customer Code",
  "Province",
  "City",
  "Kurir",
] as const;

export function ordersSheet(rows: OrderPageRow[]): Buffer {
  const data = rows.map((row) => ({
    "Tanggal Pesanan": row.tanggal.replace("T", " "),
    "No Pesanan": row.noPesanan,
    Channel: row.channel,
    "Store Name": row.storeName,
    SKU: row.sku,
    Qty: row.qty,
    "Unit Price": row.unitPrice,
    "Sub Total": row.subTotal,
    "Total Nilai Pesanan": row.totalNilaiPesanan,
    "Total Diskon": row.totalDiskon,
    "Unit Diskon": row.unitDiskon,
    "Revenue per Unit": row.revenuePerUnit,
    "Customer Name": row.customerName,
    "Customer Code": row.customerCode,
    Province: row.province,
    City: row.city,
    Kurir: row.kurir,
  }));
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(data, { header: [...COLS] });
  XLSX.utils.book_append_sheet(book, sheet, "Data");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function dashboardSheet(report: DashboardReport, compare?: { label: string; report: DashboardReport }[]): Buffer {
  const book = XLSX.utils.book_new();
  const kpi = report.kpis;
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([
    { Metrik: "Penjualan kotor", Nilai: kpi.gross },
    { Metrik: "Diskon", Nilai: kpi.disc },
    { Metrik: "Revenue bersih", Nilai: kpi.net },
    { Metrik: "Jumlah pesanan", Nilai: kpi.orders },
    { Metrik: "Qty terjual", Nilai: kpi.qty },
    { Metrik: "AOV", Nilai: kpi.aov },
  ]), "KPI");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(report.channels), "Channel");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(report.stores), "Toko");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(report.products), "Produk");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(report.provinces), "Provinsi");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(report.cities), "Kota");
  if (compare?.length) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(compare.map((item) => ({
      Periode: item.label,
      Kotor: item.report.kpis.gross,
      Diskon: item.report.kpis.disc,
      "Revenue bersih": item.report.kpis.net,
      Pesanan: item.report.kpis.orders,
      Qty: item.report.kpis.qty,
      AOV: item.report.kpis.aov,
    }))), "Perbandingan");
  }
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function syncSheet(rows: SyncReviewRow[]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map((row) => ({
    "No Pesanan": row.noPesanan,
    Tanggal: row.day,
    Channel: row.current.channel,
    Toko: row.current.storeName,
    Kategori: row.category,
    Keputusan: row.decision ?? "",
    Status: row.current.status,
    "Total Nilai": row.current.totalNilaiPesanan,
    Diskon: row.current.totalDiskon,
    Qty: row.current.qty,
    Revenue: row.current.revenue,
    Ringkasan: row.summary,
  }))), "Review");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function historySheet(batches: SyncBatch[], items: SyncBatchItem[]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(batches), "Batch");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(items), "Item");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function safe(value: unknown): string {
  return String(value ?? "").replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]/g, "?");
}

async function pdfBase(title: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([842, 595]);
  page.drawText(safe(title), { x: 32, y: 560, size: 16, font: bold, color: rgb(0.12, 0.14, 0.22) });
  return { doc, font, bold, page, y: 534 };
}

export async function pdfOrders(rows: OrderPageRow[]): Promise<Buffer> {
  const { doc, font, bold, page } = await pdfBase("Data Pesanan");
  let y = 520;
  page.drawText(safe(`${rows.length} baris · format bersih 17 kolom ringkas di PDF`), { x: 32, y, size: 10, font, color: rgb(0.4, 0.44, 0.52) });
  y -= 22;
  for (const row of rows.slice(0, 28)) {
    const line = `${row.day}  ${row.noPesanan}  ${row.channel}  ${row.sku}  qty ${row.qty}  ${Math.round(row.subTotal ?? 0)}`;
    page.drawText(safe(line).slice(0, 120), { x: 32, y, size: 9, font, color: rgb(0.1, 0.12, 0.18) });
    y -= 16;
    if (y < 40) break;
  }
  void bold;
  return Buffer.from(await doc.save());
}

export async function pdfDashboard(report: DashboardReport, subtitle: string): Promise<Buffer> {
  const { doc, font, bold, page } = await pdfBase("Dashboard E-Commerce");
  page.drawText(safe(subtitle), { x: 32, y: 538, size: 10, font, color: rgb(0.4, 0.44, 0.52) });
  const cards = [
    ["Penjualan kotor", report.kpis.gross],
    ["Diskon", report.kpis.disc],
    ["Revenue bersih", report.kpis.net],
    ["Pesanan", report.kpis.orders],
    ["Qty", report.kpis.qty],
    ["AOV", report.kpis.aov],
  ] as const;
  cards.forEach((card, index) => {
    const x = 32 + (index % 6) * 130;
    page.drawText(safe(card[0]), { x, y: 510, size: 8, font, color: rgb(0.42, 0.45, 0.52) });
    page.drawText(safe(Math.round(Number(card[1])).toLocaleString("id-ID")), { x, y: 494, size: 11, font: bold });
  });
  const max = Math.max(1, ...report.trend.map((row) => row.gross));
  report.trend.slice(0, 14).forEach((row, index) => {
    const h = (row.net / max) * 120;
    const x = 40 + index * 48;
    page.drawRectangle({ x, y: 300, width: 28, height: Math.max(1, h), color: rgb(0.31, 0.27, 0.9) });
    page.drawText(safe(row.bucket.slice(5)), { x, y: 286, size: 7, font });
  });
  page.drawText("Channel", { x: 32, y: 260, size: 11, font: bold });
  report.channels.slice(0, 8).forEach((row, index) => {
    page.drawText(safe(`${row.key}   ${Math.round(row.gross).toLocaleString("id-ID")}   ${row.orders} pesanan`), {
      x: 32, y: 242 - index * 14, size: 9, font,
    });
  });
  page.drawText("Produk", { x: 430, y: 260, size: 11, font: bold });
  report.products.slice(0, 8).forEach((row, index) => {
    page.drawText(safe(`${row.sku}   qty ${row.qty}   rev ${Math.round(row.net).toLocaleString("id-ID")}`), {
      x: 430, y: 242 - index * 14, size: 9, font,
    });
  });
  return Buffer.from(await doc.save());
}

export async function pdfSync(rows: SyncReviewRow[]): Promise<Buffer> {
  const { doc, font, page } = await pdfBase("Sync ke Accurate");
  let y = 520;
  for (const row of rows.slice(0, 30)) {
    page.drawText(safe(`${row.noPesanan}  ${row.category}  ${row.summary}`).slice(0, 130), { x: 32, y, size: 9, font });
    y -= 16;
    if (y < 40) break;
  }
  return Buffer.from(await doc.save());
}

export async function pdfHistory(batches: SyncBatch[]): Promise<Buffer> {
  const { doc, font, page } = await pdfBase("Riwayat Sync");
  let y = 520;
  for (const batch of batches.slice(0, 24)) {
    page.drawText(safe(`${batch.createdAt}  ${batch.orderCount} pesanan  berhasil ${batch.successCount}  gagal ${batch.failCount}`), {
      x: 32, y, size: 9, font,
    });
    y -= 16;
  }
  return Buffer.from(await doc.save());
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

export function orderDayLabel(day: string): string {
  return dayLabel(day);
}
