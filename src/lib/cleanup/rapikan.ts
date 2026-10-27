/**
 * Port of scripts/rapikan.py.
 * Rows with status Pending / Paid / Canceled are dropped.
 * Bundle rows whose weight key is missing are kept and flagged.
 */

export const DROPPED_STATUSES = new Set([
  "PENDING",
  "PAID",
  "CANCELED",
  "CANCELLED",
  "CANCEL",
]);

export type RawSalesRow = {
  tanggal: Date | string | null;
  noPesanan: string | null;
  ref: string | null;
  channel: string | null;
  namaToko: string | null;
  namaBarang: string | null;
  sku: string | null;
  qty: number;
  hargaJual: number;
  itemCodeBundle: string | null;
  qtyBundle: number;
  lokasiGudang: string | null;
  status: string | null;
  totalPenjualanPerProduk: number;
  diskon: number;
  diskonLainnya: number;
  biayaLainnya: number;
};

export type CleanLine = {
  noPesanan: string;
  noPesananSumber: string | null;
  channel: string;
  sku: string;
  qty: number;
  hargaJual: number | null;
  totalDiskon: number | null;
  tanggal: string | null;
  lokasiGudang: string | null;
  namaToko: string | null;
  status: string | null;
  namaBarang: string | null;
  sourceSku: string | null;
  isBundle: boolean;
  bundleKey: string | null;
  bobot: number | null;
  missingWeight: boolean;
  isShopee: boolean;
  sourceQty: number;
  sourceHarga: number;
  sourceTotalPenjualan: number;
  sourceDiskon: number;
  sourceDiskonLainnya: number;
  sourceBiayaLainnya: number;
  sourceQtyBundle: number;
};

export type CleanResult = {
  lines: CleanLine[];
  droppedCount: number;
  missingKeys: string[];
};

export function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (!s || s.toLowerCase() === "nan") return null;
  return s;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isBundleRow(itemCodeBundle: string | null): boolean {
  return itemCodeBundle != null && itemCodeBundle.trim() !== "";
}

export function isShopeeChannel(channel: string | null): boolean {
  return (channel ?? "").trim().toUpperCase() === "SHOPEE";
}

export function bundleKeyOf(sku: string | null, itemCodeBundle: string | null): string | null {
  if (!isBundleRow(itemCodeBundle)) return null;
  return `${(sku ?? "").trim()}-${(itemCodeBundle ?? "").trim()}`;
}

/** One source row -> one cleaned line, or null when the status is dropped. */
export function cleanRow(row: RawSalesRow, weights: Map<string, number>): CleanLine | null {
  const status = text(row.status);
  if (!status || DROPPED_STATUSES.has(status.toUpperCase())) return null;

  const itemCode = text(row.itemCodeBundle);
  const sourceSku = text(row.sku);
  const bundle = isBundleRow(itemCode);
  const key = bundleKeyOf(sourceSku, itemCode);
  const shopee = isShopeeChannel(row.channel);
  const missingWeight = bundle && (key == null || !weights.has(key));
  const bobot = bundle ? (key != null && weights.has(key) ? weights.get(key)! : null) : 1;

  const qty = Math.trunc(bundle ? num(row.qtyBundle) * num(row.qty) : num(row.qty));
  let hargaJual: number | null;
  let totalDiskon: number | null;
  if (bobot == null) {
    hargaJual = null;
    totalDiskon = null;
  } else if (shopee) {
    hargaJual = num(row.totalPenjualanPerProduk) * bobot;
    totalDiskon = num(row.diskonLainnya) * bobot;
  } else {
    hargaJual = num(row.qty) * num(row.hargaJual) * bobot;
    totalDiskon = (num(row.diskon) + num(row.diskonLainnya) + num(row.biayaLainnya)) * bobot;
  }

  const ref = text(row.ref);
  const sumber = text(row.noPesanan);
  const noPesanan = ref ?? sumber ?? "";

  return {
    noPesanan,
    noPesananSumber: sumber,
    channel: text(row.channel) ?? "",
    sku: (bundle ? itemCode : sourceSku) ?? "",
    qty,
    hargaJual,
    totalDiskon,
    tanggal: toIso(row.tanggal),
    lokasiGudang: text(row.lokasiGudang),
    namaToko: text(row.namaToko),
    status,
    namaBarang: text(row.namaBarang),
    sourceSku,
    isBundle: bundle,
    bundleKey: key,
    bobot,
    missingWeight,
    isShopee: shopee,
    sourceQty: num(row.qty),
    sourceHarga: num(row.hargaJual),
    sourceTotalPenjualan: num(row.totalPenjualanPerProduk),
    sourceDiskon: num(row.diskon),
    sourceDiskonLainnya: num(row.diskonLainnya),
    sourceBiayaLainnya: num(row.biayaLainnya),
    sourceQtyBundle: num(row.qtyBundle),
  };
}

/** Recalculate qty and money from the stored source numbers and the current weight table. */
export function recomputeAmounts(line: {
  isBundle: boolean;
  bundleKey: string | null;
  isShopee: boolean;
  sourceQty: number;
  sourceHarga: number;
  sourceTotalPenjualan: number;
  sourceDiskon: number;
  sourceDiskonLainnya: number;
  sourceBiayaLainnya: number;
  sourceQtyBundle: number;
}, weights: Map<string, number>): {
  qty: number;
  hargaJual: number | null;
  totalDiskon: number | null;
  bobot: number | null;
  missingWeight: boolean;
} {
  const missingWeight = line.isBundle && (line.bundleKey == null || !weights.has(line.bundleKey));
  const bobot = line.isBundle
    ? line.bundleKey != null && weights.has(line.bundleKey)
      ? weights.get(line.bundleKey)!
      : null
    : 1;
  const qty = Math.trunc(line.isBundle ? line.sourceQtyBundle * line.sourceQty : line.sourceQty);
  if (bobot == null) {
    return { qty, hargaJual: null, totalDiskon: null, bobot: null, missingWeight };
  }
  if (line.isShopee) {
    return {
      qty,
      hargaJual: line.sourceTotalPenjualan * bobot,
      totalDiskon: line.sourceDiskonLainnya * bobot,
      bobot,
      missingWeight: false,
    };
  }
  return {
    qty,
    hargaJual: line.sourceQty * line.sourceHarga * bobot,
    totalDiskon: (line.sourceDiskon + line.sourceDiskonLainnya + line.sourceBiayaLainnya) * bobot,
    bobot,
    missingWeight: false,
  };
}

export function rapikan(rows: RawSalesRow[], weights: Map<string, number>): CleanResult {
  const lines: CleanLine[] = [];
  let droppedCount = 0;
  const missing = new Set<string>();
  for (const row of rows) {
    const line = cleanRow(row, weights);
    if (!line) {
      droppedCount += 1;
      continue;
    }
    if (line.missingWeight && line.bundleKey) missing.add(line.bundleKey);
    lines.push(line);
  }
  return { lines, droppedCount, missingKeys: [...missing].sort() };
}
