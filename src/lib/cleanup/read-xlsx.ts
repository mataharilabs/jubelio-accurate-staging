import * as XLSX from "xlsx";
import {
  channelStoreKey,
  cityKey,
  normKey,
  num,
  provinceKey,
  text,
  type ChannelStoreMapping,
  type CityMapping,
  type CleanLine,
  type ProvinceMapping,
  type RawSalesRow,
} from "@/lib/cleanup/rapikan";

export class WorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookError";
  }
}

const RAW_REQUIRED = [
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
  "Tanggal",
] as const;

const CLEAN_REQUIRED = [
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

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(value * 86400000);
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function headerIndex(headers: string[]): Map<string, number> {
  const index = new Map<string, number>();
  headers.forEach((name, i) => {
    if (name) index.set(name, i);
  });
  return index;
}

function requireColumns(index: Map<string, number>, required: readonly string[], label: string) {
  const missing = required.filter((name) => !index.has(name));
  if (missing.length) throw new WorkbookError(`Kolom wajib tidak ada di ${label}: ${missing.join(", ")}.`);
}

export function readSalesWorkbook(buffer: Buffer): RawSalesRow[] {
  const book = workbook(buffer);
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new WorkbookError("Berkas tidak berisi lembar kerja.");
  const matrix = sheetMatrix(sheet);
  const headers = (matrix[0] ?? []).map((cell) => text(cell) ?? "");
  const index = headerIndex(headers);
  requireColumns(index, RAW_REQUIRED, "ekspor Jubelio");
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
      pelanggan: text(at(row, "Pelanggan")),
      kota: text(at(row, "Kota")),
      provinsi: text(at(row, "Provinsi")),
      namaBarang: text(at(row, "Nama Barang")),
      sku,
      qty: num(at(row, "Qty")),
      hargaJual: num(at(row, "Harga Jual")),
      itemCodeBundle: text(at(row, "item_code_bundle")),
      itemNameBundle: text(at(row, "item_name_bundle")),
      qtyBundle: num(at(row, "qty_bundle")),
      kurir: text(at(row, "Kurir")),
      lokasiGudang: text(at(row, "Lokasi Gudang")),
      status,
      totalPenjualanPerProduk: num(at(row, "Total Penjualan Per Produk")),
      diskon: num(at(row, "Diskon")),
      diskonLainnya: num(at(row, "Diskon Lainnya")),
      biayaLainnya: num(at(row, "Biaya Lainnya")),
    });
  }
  return rows;
}

export function readWeightWorkbook(buffer: Buffer): { bundleKey: string; bobot: number }[] {
  const book = workbook(buffer);
  const name = book.SheetNames.includes("Tabel Bundle") ? "Tabel Bundle" : book.SheetNames[0];
  const sheet = book.Sheets[name];
  if (!sheet) throw new WorkbookError("Lembar bobot tidak ditemukan.");
  const matrix = sheetMatrix(sheet);
  let keyCol = 1;
  let valueCol = 2;
  for (const row of matrix) {
    const idx = row.findIndex((cell) => normKey(text(cell)) === "sku bundle");
    if (idx >= 0) {
      keyCol = idx;
      valueCol = idx + 1;
      break;
    }
  }
  const rows: { bundleKey: string; bobot: number }[] = [];
  for (const row of matrix) {
    const key = text(row[keyCol]);
    const bobot = row[valueCol];
    if (!key || normKey(key) === "sku bundle") continue;
    if (bobot == null || bobot === "") continue;
    const value = typeof bobot === "number" ? bobot : Number(String(bobot).trim());
    if (!Number.isFinite(value)) continue;
    rows.push({ bundleKey: key.trim(), bobot: value });
  }
  if (!rows.length) throw new WorkbookError("Tabel bobot kosong. Pakai lembar Tabel Bundle, kolom SKU BUNDLE dan BOBOT PER ITEM.");
  return rows;
}

export function readChannelStoreWorkbook(buffer: Buffer): ChannelStoreMapping[] {
  const book = workbook(buffer);
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new WorkbookError("Berkas mapping channel kosong.");
  const matrix = sheetMatrix(sheet);
  let header = -1;
  for (let i = 0; i < matrix.length; i += 1) {
    const labels = matrix[i].map((cell) => (text(cell) ?? "").trim().toLowerCase());
    if (labels.filter((label) => label === "channel").length >= 2) {
      header = i;
      break;
    }
  }
  if (header < 0) throw new WorkbookError("Header Channel / Nama Toko tidak ditemukan.");
  const labels = matrix[header].map((cell) => (text(cell) ?? "").trim().toLowerCase());
  const cols = labels
    .map((label, index) => (label === "channel" || label === "nama toko" ? index : -1))
    .filter((index) => index >= 0)
    .slice(0, 4);
  if (cols.length < 4) throw new WorkbookError("Mapping channel butuh 4 kolom: Channel, Nama Toko, Channel, Nama Toko.");
  const rows: ChannelStoreMapping[] = [];
  const seen = new Set<string>();
  for (const row of matrix.slice(header + 1)) {
    const channelRaw = text(row[cols[0]]);
    if (!channelRaw?.trim()) continue;
    const storeRaw = text(row[cols[1]]) ?? "";
    const channel = (text(row[cols[2]]) ?? "").trim();
    const store = (text(row[cols[3]]) ?? "").trim();
    const key = channelStoreKey(channelRaw, storeRaw, false);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ channelRaw: channelRaw.trim(), storeRaw: storeRaw.trim(), channel, store });
  }
  return rows;
}

function reviewFlag(value: unknown): boolean {
  return (text(value) ?? "").trim().toUpperCase() === "YA";
}

export function readProvinceWorkbook(buffer: Buffer): ProvinceMapping[] {
  const book = workbook(buffer);
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new WorkbookError("Berkas mapping provinsi kosong.");
  const matrix = sheetMatrix(sheet);
  const headers = (matrix[0] ?? []).map((cell) => text(cell) ?? "");
  const index = headerIndex(headers);
  requireColumns(index, ["Provinsi (Jubelio)", "Provinsi Resmi"], "mapping provinsi");
  const rows: ProvinceMapping[] = [];
  const seen = new Set<string>();
  for (const row of matrix.slice(1)) {
    const raw = text(row[index.get("Provinsi (Jubelio)")!]) ?? "";
    if (seen.has(raw)) continue;
    seen.add(raw);
    rows.push({
      raw,
      official: text(row[index.get("Provinsi Resmi")!]) ?? "",
      needsReview: reviewFlag(index.has("Perlu Review") ? row[index.get("Perlu Review")!] : null),
    });
  }
  return rows;
}

export function readCityWorkbook(buffer: Buffer): CityMapping[] {
  const book = workbook(buffer);
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new WorkbookError("Berkas mapping kota kosong.");
  const matrix = sheetMatrix(sheet);
  const headers = (matrix[0] ?? []).map((cell) => text(cell) ?? "");
  const index = headerIndex(headers);
  requireColumns(index, ["Provinsi (Jubelio)", "Kota (Jubelio)", "Kab/Kota Resmi"], "mapping kota");
  const rows: CityMapping[] = [];
  const seen = new Set<string>();
  for (const row of matrix.slice(1)) {
    const provinceRaw = text(row[index.get("Provinsi (Jubelio)")!]) ?? "";
    const cityRaw = text(row[index.get("Kota (Jubelio)")!]) ?? "";
    const key = cityKey(provinceRaw, cityRaw);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      provinceRaw,
      cityRaw,
      official: text(row[index.get("Kab/Kota Resmi")!]) ?? "",
      needsReview: reviewFlag(index.has("Perlu Review") ? row[index.get("Perlu Review")!] : null),
    });
  }
  return rows;
}

export type CleanSheetRow = CleanLine;

export function readCleanWorkbook(buffer: Buffer): CleanLine[] {
  const book = workbook(buffer);
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new WorkbookError("Berkas rapi kosong.");
  const matrix = sheetMatrix(sheet);
  const headers = (matrix[0] ?? []).map((cell) => text(cell) ?? "");
  const index = headerIndex(headers);
  requireColumns(index, CLEAN_REQUIRED, "berkas rapi");
  const at = (row: unknown[], name: string) => row[index.get(name)!];
  const lines: CleanLine[] = [];
  for (const row of matrix.slice(1)) {
    const noPesanan = text(at(row, "No Pesanan"));
    const sku = text(at(row, "SKU"));
    if (!noPesanan && !sku) continue;
    const tanggal = asDate(at(row, "Tanggal Pesanan"));
    const iso = tanggal ? new Date(Math.round(tanggal.getTime() / 1000) * 1000).toISOString().replace(".000Z", "") : "";
    const status = index.has("Status") ? (text(at(row, "Status")) ?? "") : "";
    lines.push({
      tanggal: iso,
      day: iso.slice(0, 10),
      noPesanan: noPesanan ?? "",
      channel: text(at(row, "Channel")) ?? "",
      storeName: text(at(row, "Store Name")) ?? "",
      sku: sku ?? "",
      productName: index.has("Nama Produk") ? (text(at(row, "Nama Produk")) ?? "") : "",
      qty: Math.trunc(num(at(row, "Qty"))),
      unitPrice: num(at(row, "Unit Price")),
      subTotal: num(at(row, "Sub Total")),
      totalNilaiPesanan: num(at(row, "Total Nilai Pesanan")),
      totalDiskon: num(at(row, "Total Diskon")),
      unitDiskon: num(at(row, "Unit Diskon")),
      revenuePerUnit: num(at(row, "Revenue per Unit")),
      customerName: text(at(row, "Customer Name")) ?? "",
      customerCode: text(at(row, "Customer Code")) ?? "",
      province: text(at(row, "Province")) ?? "",
      city: text(at(row, "City")) ?? "",
      kurir: text(at(row, "Kurir")) ?? "",
      status,
      lokasiGudang: index.has("Lokasi Gudang") ? text(at(row, "Lokasi Gudang")) : null,
      missingWeight: false,
      bundleKey: null,
      flags: [],
    });
  }
  return lines;
}

export function weightMap(rows: { bundleKey: string; bobot: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.bundleKey, row.bobot);
  return map;
}

export function channelMap(rows: ChannelStoreMapping[]): Map<string, { channel: string; store: string }> {
  const map = new Map<string, { channel: string; store: string }>();
  for (const row of rows) {
    const pos = row.channelRaw.trim().toUpperCase() === "JUBELIO-POS";
    const key = channelStoreKey(row.channelRaw, row.storeRaw, pos);
    if (!map.has(key)) map.set(key, { channel: row.channel, store: row.store });
    if (!pos) {
      const plain = channelStoreKey(row.channelRaw, row.storeRaw, false);
      if (!map.has(plain)) map.set(plain, { channel: row.channel, store: row.store });
    }
  }
  return map;
}

export function provinceMap(rows: ProvinceMapping[]): Map<string, ProvinceMapping> {
  const map = new Map<string, ProvinceMapping>();
  for (const row of rows) map.set(provinceKey(row.raw), row);
  return map;
}

export function cityMap(rows: CityMapping[]): Map<string, CityMapping> {
  const map = new Map<string, CityMapping>();
  for (const row of rows) map.set(cityKey(row.provinceRaw, row.cityRaw), row);
  return map;
}
