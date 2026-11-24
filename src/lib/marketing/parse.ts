import * as XLSX from "xlsx";
import { monthBoundaryMessage, parseDate, parseDateRange, sameCalendarMonth } from "@/lib/marketing/dates";
import { AppError } from "@/lib/errors";
import { PLATFORMS, type ParseResult, type Platform, type SkippedRow, type SpendDraft } from "@/lib/marketing/types";

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let text = String(value).trim();
  if (!text || text === "-" || text === "—" || text === "–") return null;
  text = text.replace(/rp/ig, "").replace(/%/g, "").replace(/\s/g, "");
  if (!text) return null;
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  const hasDot = text.includes(".");
  const hasComma = text.includes(",");
  if (hasDot && hasComma) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
  } else if (hasComma || hasDot) {
    const sep = hasComma ? "," : ".";
    const parts = text.split(sep);
    const grouped = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0] !== "0");
    if (grouped) text = parts.join("");
    else if (sep === ",") text = text.replace(",", ".");
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function money(value: unknown): number | null {
  const parsed = parseNumber(value);
  if (parsed == null) return null;
  return Math.round(parsed * 100) / 100;
}

function count(value: unknown): number | null {
  const parsed = parseNumber(value);
  if (parsed == null) return null;
  return Math.round(parsed);
}

function cellText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function indexMap(header: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((cell, index) => {
    const key = cellText(cell).toLowerCase();
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function findHeader(rows: unknown[][], required: string[]): { index: number; map: Map<string, number> } | null {
  const need = required.map((name) => name.toLowerCase());
  for (let index = 0; index < rows.length; index += 1) {
    const map = indexMap(rows[index] ?? []);
    if (need.every((name) => map.has(name))) return { index, map };
  }
  return null;
}

function pick(map: Map<string, number>, row: unknown[], name: string): unknown {
  const index = map.get(name.toLowerCase());
  return index == null ? "" : row[index];
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ""));
}

function sheetRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true });
}

export function readTable(buffer: Buffer, filename: string, required: string[] = []): unknown[][] {
  const lower = filename.toLowerCase();
  const looksText = lower.endsWith(".csv") || lower.endsWith(".txt");
  if (looksText) return parseCsv(buffer.toString("utf8"));
  const book = XLSX.read(buffer, { type: "buffer", cellDates: false });
  if (!book.SheetNames.length) return [];
  if (required.length) {
    for (const name of book.SheetNames) {
      const rows = sheetRows(book.Sheets[name]);
      if (findHeader(rows, required)) return rows;
    }
  }
  const preferred = book.SheetNames.find((name) => name.toLowerCase() === "raw data report");
  return sheetRows(book.Sheets[preferred ?? book.SheetNames[0]]);
}

function blankResult(kind: ParseResult["kind"], platform: string, splitDaily = false): ParseResult {
  return {
    kind,
    platform,
    splitDaily,
    storeRaw: null,
    periodStart: null,
    periodEnd: null,
    rows: [],
    skipped: [],
    readCount: 0,
    crossesMonth: false,
    monthMessage: null,
    note: null,
  };
}

function spanOf(rows: SpendDraft[]): { start: string | null; end: string | null } {
  if (!rows.length) return { start: null, end: null };
  return {
    start: rows.reduce((min, row) => row.periodStart < min ? row.periodStart : min, rows[0].periodStart),
    end: rows.reduce((max, row) => row.periodEnd > max ? row.periodEnd : max, rows[0].periodEnd),
  };
}

function rejectAggregate(result: ParseResult, filename: string, store: string | null) {
  const span = spanOf(result.rows);
  result.periodStart = span.start;
  result.periodEnd = span.end;
  if (!span.start || !span.end) return;
  const crosses = result.rows.some((row) => !sameCalendarMonth(row.periodStart, row.periodEnd)) || !sameCalendarMonth(span.start, span.end);
  if (!crosses) return;
  result.crossesMonth = true;
  result.monthMessage = monthBoundaryMessage(filename, result.platform, store ?? result.storeRaw, span.start, span.end);
  result.rows = [];
}

export function parseShopee(rows: unknown[][], filename: string): ParseResult {
  const result = blankResult("shopee", "Shopee Ads");
  for (const row of rows) {
    const key = cellText(row[0]).toLowerCase();
    if (key === "nama toko") result.storeRaw = cellText(row[1]) || null;
    if (key === "periode") {
      const range = parseDateRange(row[1]);
      if (range) {
        result.periodStart = range.start;
        result.periodEnd = range.end;
      }
    }
  }
  const header = findHeader(rows, ["Nama Iklan", "Biaya", "Dilihat", "Jumlah Klik", "Produk Terjual", "Omzet Penjualan"]);
  if (!header) throw new AppError("Berkas ini bukan laporan Shopee Ads. Header Nama Iklan / Biaya tidak ditemukan.");
  if (!result.periodStart || !result.periodEnd) throw new AppError("Periode laporan Shopee tidak ditemukan. Baris Periode harus berisi DD/MM/YYYY - DD/MM/YYYY.");
  for (let index = header.index + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const campaign = cellText(pick(header.map, row, "Nama Iklan"));
    if (!campaign) continue;
    const spend = money(pick(header.map, row, "Biaya"));
    if (spend == null) {
      result.skipped.push({ row: index + 1, reason: "baris tanpa biaya" });
      result.readCount += 1;
      continue;
    }
    result.readCount += 1;
    result.rows.push({
      lineNo: result.rows.length + 1,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      platform: "Shopee Ads",
      storeRaw: result.storeRaw,
      campaign,
      spend,
      impressions: count(pick(header.map, row, "Dilihat")),
      clicks: count(pick(header.map, row, "Jumlah Klik")),
      orders: count(pick(header.map, row, "Produk Terjual")),
      adsRevenue: money(pick(header.map, row, "Omzet Penjualan")),
    });
  }
  rejectAggregate(result, filename, result.storeRaw);
  return result;
}

export function parseTikTok(rows: unknown[][], filename: string): ParseResult {
  const result = blankResult("tiktok", "TikTok Ads", true);
  const header = findHeader(rows, ["By Day", "Cost", "SKU orders (Current shop)", "Gross revenue (Current shop)"]);
  if (!header) throw new AppError("Berkas ini bukan laporan TikTok GMV Max. Header By Day / Cost tidak ditemukan.");
  for (let index = header.index + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const rawDay = cellText(pick(header.map, row, "By Day"));
    if (!rawDay) continue;
    result.readCount += 1;
    const day = parseDate(pick(header.map, row, "By Day"));
    if (!day || rawDay === "-") {
      result.skipped.push({ row: index + 1, reason: "baris total" });
      continue;
    }
    const spend = money(pick(header.map, row, "Cost"));
    if (spend == null) {
      result.skipped.push({ row: index + 1, reason: "baris tanpa biaya" });
      continue;
    }
    result.rows.push({
      lineNo: result.rows.length + 1,
      periodStart: day,
      periodEnd: day,
      platform: "TikTok Ads",
      storeRaw: null,
      campaign: "GMV Max",
      spend,
      impressions: null,
      clicks: null,
      orders: count(pick(header.map, row, "SKU orders (Current shop)")),
      adsRevenue: money(pick(header.map, row, "Gross revenue (Current shop)")),
    });
  }
  const span = spanOf(result.rows);
  result.periodStart = span.start;
  result.periodEnd = span.end;
  if (span.start && span.end && !sameCalendarMonth(span.start, span.end)) {
    result.note = `File ${filename} mencakup lebih dari satu bulan. Baris harian TikTok dipisah per tanggal dan tetap bisa disimpan.`;
  }
  return result;
}

function parseMetaFamily(rows: unknown[][], filename: string, kind: "meta" | "cpas"): ParseResult {
  const platform = kind === "cpas" ? "CPAS" : "Meta Ads";
  const result = blankResult(kind, platform);
  const required = ["Campaign name", "Amount spent (IDR)", "Impressions", "Link clicks", "Reporting starts", "Reporting ends"];
  const header = findHeader(rows, required);
  if (!header) throw new AppError(`Berkas ini bukan laporan ${platform}. Header Campaign name / Amount spent (IDR) tidak ditemukan.`);
  const ordersColumn = kind === "cpas" ? "Purchases with shared items" : "";
  const revenueColumn = kind === "cpas" ? "Purchases conversion value for shared items only" : "";
  if (kind === "cpas" && (!header.map.has(ordersColumn.toLowerCase()) || !header.map.has(revenueColumn.toLowerCase()))) {
    throw new AppError("Berkas CPAS tidak punya kolom Purchases with shared items.");
  }
  for (let index = header.index + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const campaign = cellText(pick(header.map, row, "Campaign name"));
    const spend = money(pick(header.map, row, "Amount spent (IDR)"));
    const impressions = count(pick(header.map, row, "Impressions"));
    const clicks = count(pick(header.map, row, "Link clicks"));
    const hasNumbers = spend != null || impressions != null || clicks != null;
    if (!campaign && !hasNumbers) continue;
    result.readCount += 1;
    if (!campaign) {
      result.skipped.push({ row: index + 1, reason: "baris total tanpa nama kampanye" });
      continue;
    }
    const start = parseDate(pick(header.map, row, "Reporting starts"));
    const end = parseDate(pick(header.map, row, "Reporting ends"));
    if (!start || !end || end < start) {
      result.skipped.push({ row: index + 1, reason: "periode tidak terbaca" });
      continue;
    }
    if (spend == null) {
      result.skipped.push({ row: index + 1, reason: "baris tanpa biaya" });
      continue;
    }
    result.rows.push({
      lineNo: result.rows.length + 1,
      periodStart: start,
      periodEnd: end,
      platform,
      storeRaw: null,
      campaign,
      spend,
      impressions,
      clicks,
      orders: kind === "cpas" ? count(pick(header.map, row, ordersColumn)) : null,
      adsRevenue: kind === "cpas" ? money(pick(header.map, row, revenueColumn)) : null,
    });
  }
  rejectAggregate(result, filename, null);
  return result;
}

const TEMPLATE_COLUMNS = ["tanggal_mulai", "tanggal_selesai", "platform", "toko", "nama_kampanye", "spend", "impresi", "klik", "pesanan_iklan", "omzet_iklan"];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export function normalizePlatform(value: string): Platform | null {
  const text = value.trim().toLowerCase();
  return PLATFORMS.find((item) => item.toLowerCase() === text) ?? null;
}

export function parseTemplate(rows: unknown[][], filename: string, fallbackPlatform: string | null): ParseResult {
  const result = blankResult("template", fallbackPlatform || "Template Excel");
  const header = findHeader(rows, ["tanggal_mulai", "tanggal_selesai", "platform", "toko", "spend"]);
  if (!header) throw new AppError("Berkas ini bukan template Excel standar. Kolom tanggal_mulai tidak ditemukan. Unduh templatenya, isi, lalu unggah lagi.");
  const crossing: SkippedRow[] = [];
  const unknown: SkippedRow[] = [];
  for (let index = header.index + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const values = TEMPLATE_COLUMNS.map((name) => pick(header.map, row, name));
    if (values.every((value) => cellText(value) === "")) continue;
    result.readCount += 1;
    const rawPlatform = cellText(pick(header.map, row, "platform"));
    const platform = rawPlatform ? normalizePlatform(rawPlatform) : (fallbackPlatform && isPlatform(fallbackPlatform) ? fallbackPlatform : null);
    if (rawPlatform && !platform) {
      unknown.push({ row: index + 1, reason: `platform tidak dikenal: ${rawPlatform}` });
      continue;
    }
    const start = parseDate(pick(header.map, row, "tanggal_mulai"));
    const end = parseDate(pick(header.map, row, "tanggal_selesai"));
    const storeRaw = cellText(pick(header.map, row, "toko"));
    const spend = money(pick(header.map, row, "spend"));
    if (!start || !end || end < start) {
      result.skipped.push({ row: index + 1, reason: "tanggal tidak terbaca" });
      continue;
    }
    if (!sameCalendarMonth(start, end)) {
      crossing.push({ row: index + 1, reason: "lintas bulan" });
      continue;
    }
    if (!platform) {
      result.skipped.push({ row: index + 1, reason: "platform kosong" });
      continue;
    }
    if (!storeRaw) {
      result.skipped.push({ row: index + 1, reason: "toko kosong" });
      continue;
    }
    if (spend == null) {
      result.skipped.push({ row: index + 1, reason: "spend kosong" });
      continue;
    }
    result.rows.push({
      lineNo: result.rows.length + 1,
      periodStart: start,
      periodEnd: end,
      platform,
      storeRaw,
      campaign: cellText(pick(header.map, row, "nama_kampanye")),
      spend,
      impressions: count(pick(header.map, row, "impresi")),
      clicks: count(pick(header.map, row, "klik")),
      orders: count(pick(header.map, row, "pesanan_iklan")),
      adsRevenue: money(pick(header.map, row, "omzet_iklan")),
    });
  }
  const span = spanOf(result.rows.length ? result.rows : []);
  result.periodStart = span.start;
  result.periodEnd = span.end;
  if (crossing.length || unknown.length) {
    result.rows = [];
    const parts: string[] = [];
    if (crossing.length) {
      result.crossesMonth = true;
      result.skipped.push(...crossing);
      const sample = crossing.map((item) => `baris ${item.row}`).join(", ");
      parts.push(`Template ${filename} punya ${crossing.length} baris lintas bulan (${sample}). Tanggal mulai dan selesai harus dalam bulan yang sama.`);
    }
    if (unknown.length) {
      result.skipped.push(...unknown);
      const names = [...new Set(unknown.map((item) => item.reason.replace("platform tidak dikenal: ", "")))].join(", ");
      parts.push(`Platform tidak dikenal: ${names}. Gunakan ${PLATFORMS.join(", ")}. Sel platform yang kosong mengikuti platform yang dipilih saat unggah. Upload ditolak.`);
    }
    result.monthMessage = parts.join(" ");
  }
  return result;
}

export function parseUpload(filename: string, buffer: Buffer, platform: string): ParseResult {
  const selected = platform.trim();
  if (selected === "Shopee Ads") return parseShopee(readTable(buffer, filename, ["Nama Iklan", "Biaya"]), filename);
  if (selected === "TikTok Ads") return parseTikTok(readTable(buffer, filename, ["By Day", "Cost"]), filename);
  if (selected === "Meta Ads") return parseMetaFamily(readTable(buffer, filename, ["Campaign name", "Amount spent (IDR)"]), filename, "meta");
  if (selected === "CPAS") return parseMetaFamily(readTable(buffer, filename, ["Campaign name", "Purchases with shared items"]), filename, "cpas");
  const fallback = selected === "Template Excel" ? null : selected;
  return parseTemplate(readTable(buffer, filename, ["tanggal_mulai", "spend"]), filename, fallback);
}
