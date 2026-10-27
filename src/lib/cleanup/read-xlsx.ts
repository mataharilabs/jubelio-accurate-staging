import * as XLSX from "xlsx";
import { num, text, type RawSalesRow } from "@/lib/cleanup/rapikan";

const REQUIRED = [
  "Status",
  "Qty",
  "Harga Jual",
  "Total Penjualan Per Produk",
  "Diskon",
  "Diskon Lainnya",
  "Biaya Lainnya",
  "qty_bundle",
  "item_code_bundle",
  "Channel",
  "REF",
  "No Pesanan",
  "SKU",
] as const;

export class WorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookError";
  }
}

function workbook(buffer: Buffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: "buffer", cellDates: true, raw: true });
}

function sheetMatrix(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false,
  });
}

function roundSecond(value: Date): Date {
  return new Date(Math.round(value.getTime() / 1000) * 1000);
}

function asDate(value: unknown): Date | string | null {
  if (value instanceof Date) return roundSecond(value);
  return text(value);
}

export function readSalesWorkbook(buffer: Buffer): RawSalesRow[] {
  const book = workbook(buffer);
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new WorkbookError("Berkas tidak berisi lembar kerja.");
  const matrix = sheetMatrix(sheet);
  const headers = (matrix[0] ?? []).map((cell) => text(cell) ?? "");
  const index = new Map<string, number>();
  headers.forEach((name, i) => {
    if (name) index.set(name, i);
  });
  const missing = REQUIRED.filter((name) => !index.has(name));
  if (missing.length) {
    throw new WorkbookError(
      `Kolom wajib tidak ada: ${missing.join(", ")}. Unggah ekspor Laporan Penjualan Jubelio.`,
    );
  }
  const at = (row: unknown[], name: string) => row[index.get(name)!];

  const rows: RawSalesRow[] = [];
  for (const row of matrix.slice(1)) {
    const noPesanan = text(at(row, "No Pesanan"));
    const sku = text(at(row, "SKU"));
    const status = text(at(row, "Status"));
    if (!noPesanan && !sku && !status) continue;
    rows.push({
      tanggal: asDate(at(row, "Tanggal")),
      noPesanan,
      ref: text(at(row, "REF")),
      channel: text(at(row, "Channel")),
      namaToko: text(at(row, "Nama Toko")),
      namaBarang: text(at(row, "Nama Barang")),
      sku,
      qty: num(at(row, "Qty")),
      hargaJual: num(at(row, "Harga Jual")),
      itemCodeBundle: text(at(row, "item_code_bundle")),
      qtyBundle: num(at(row, "qty_bundle")),
      lokasiGudang: text(at(row, "Lokasi Gudang")),
      status,
      totalPenjualanPerProduk: num(at(row, "Total Penjualan Per Produk")),
      diskon: num(at(row, "Diskon")),
      diskonLainnya: num(at(row, "Diskon Lainnya")),
      biayaLainnya: num(at(row, "Biaya Lainnya")),
    });
  }
  if (!rows.length) throw new WorkbookError("Berkas tidak berisi baris penjualan.");
  return rows;
}

export type WeightRow = { bundleKey: string; bobot: number };

/**
 * Kolom B = kunci `<SKU bundle>-<item_code>`, kolom C = bobot.
 * Baris judul "SKU BUNDLE" diabaikan. Kunci ganda: nilai terakhir menang.
 */
export function readWeightWorkbook(buffer: Buffer): WeightRow[] {
  const book = workbook(buffer);
  const name = book.SheetNames.includes("Tabel Bundle") ? "Tabel Bundle" : book.SheetNames[0];
  const sheet = book.Sheets[name];
  if (!sheet) throw new WorkbookError("Tabel bobot tidak berisi lembar kerja.");
  const range = XLSX.utils.decode_range(sheet["!ref"] || "B1:C1");
  const seen = new Map<string, number>();
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const keyCell = sheet[XLSX.utils.encode_cell({ r, c: 1 })] as XLSX.CellObject | undefined;
    const weightCell = sheet[XLSX.utils.encode_cell({ r, c: 2 })] as XLSX.CellObject | undefined;
    const key = text(keyCell?.v);
    if (!key || key.toUpperCase() === "SKU BUNDLE") continue;
    const bobot = num(weightCell?.v);
    if (!weightCell || !Number.isFinite(bobot)) continue;
    seen.set(key, bobot);
  }
  if (!seen.size) {
    throw new WorkbookError(
      "Tidak ada baris bobot. Pastikan kolom B berisi kunci SKU BUNDLE dan kolom C berisi BOBOT PER ITEM.",
    );
  }
  return [...seen.entries()].map(([bundleKey, bobot]) => ({ bundleKey, bobot }));
}

export function reportDateFromFilename(filename: string, linesTanggal: (string | null)[]): string {
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const counts = new Map<string, number>();
  for (const iso of linesTanggal) {
    if (!iso) continue;
    const day = iso.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let best = "";
  let n = 0;
  for (const [day, count] of counts) {
    if (count > n) {
      best = day;
      n = count;
    }
  }
  return best || new Date().toISOString().slice(0, 10);
}

export type RapiRow = {
  noPesanan: string;
  channel: string;
  sku: string;
  qty: number;
  hargaJual: number;
  totalDiskon: number;
};

export function readRapiWorkbook(buffer: Buffer): RapiRow[] {
  const book = workbook(buffer);
  const sheet = book.Sheets.Data ?? book.Sheets[book.SheetNames[0]];
  const matrix = sheetMatrix(sheet);
  return matrix.slice(1).map((row) => ({
    noPesanan: text(row[0]) ?? "",
    channel: text(row[1]) ?? "",
    sku: text(row[2]) ?? "",
    qty: num(row[3]),
    hargaJual: num(row[4]),
    totalDiskon: num(row[5]),
  }));
}
