import * as XLSX from "xlsx";
import { PLATFORMS } from "@/lib/marketing/types";

export const TEMPLATE_HEADERS = [
  "tanggal_mulai",
  "tanggal_selesai",
  "platform",
  "toko",
  "nama_kampanye",
  "spend",
  "impresi",
  "klik",
  "pesanan_iklan",
  "omzet_iklan",
] as const;

export function templateWorkbook(): Buffer {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [...TEMPLATE_HEADERS],
    ["09/11/2026", "15/11/2026", "Lazada Ads", "Nama Toko", "Nama kampanye", 250000, "", "", "", ""],
  ]);
  sheet["!cols"] = TEMPLATE_HEADERS.map((header) => ({ wch: Math.max(header.length + 2, 16) }));
  XLSX.utils.book_append_sheet(book, sheet, "Marketing");
  const help = XLSX.utils.aoa_to_sheet([
    ["Kolom", "Wajib", "Keterangan"],
    ["tanggal_mulai", "Ya", "Format hh/bb/tttt, misalnya 09/11/2026"],
    ["tanggal_selesai", "Ya", "Harus dalam bulan yang sama dengan tanggal_mulai"],
    ["platform", "Ya", PLATFORMS.join(", ")],
    ["toko", "Ya", "Nama toko harus sama dengan daftar toko di aplikasi"],
    ["nama_kampanye", "Tidak", "Nama kampanye atau iklan"],
    ["spend", "Ya", "Biaya iklan dalam Rupiah, apa adanya dari report (jangan tambah PPN)"],
    ["impresi", "Tidak", "Jumlah tayangan"],
    ["klik", "Tidak", "Jumlah klik"],
    ["pesanan_iklan", "Tidak", "Pesanan / konversi yang berasal dari iklan"],
    ["omzet_iklan", "Tidak", "Omzet (Rp) yang berasal dari iklan"],
  ]);
  XLSX.utils.book_append_sheet(book, help, "Petunjuk");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function exportWorkbook(rows: Record<string, string | number | null>[]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Marketing Spending");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function exportCsv(rows: Record<string, string | number | null>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: string | number | null) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
}
