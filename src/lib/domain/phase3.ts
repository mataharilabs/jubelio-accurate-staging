import type { OrderVersion } from "@/lib/db/types";

/** Accurate HPP is DPP. Dashboards use HPP including PPN. */
export const HPP_PPN_FACTOR = 1.11;

export type DataStatus = "active" | "deleted";
export type ReturnCase = 1 | 2 | 3;

export function hppInclusive(dpp: number | null | undefined): number {
  if (dpp == null || !Number.isFinite(dpp)) return 0;
  return Math.round(dpp * HPP_PPN_FACTOR);
}

export function hppIsPending(unitCost: number | null | undefined): boolean {
  return unitCost == null || !Number.isFinite(unitCost);
}

export function wibDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function shiftDay(day: string, delta: number): string {
  const stamp = new Date(`${day}T00:00:00Z`);
  stamp.setUTCDate(stamp.getUTCDate() + delta);
  return stamp.toISOString().slice(0, 10);
}

export function yesterdayWib(now = new Date()): string {
  return shiftDay(wibDate(now), -1);
}

/** Default dashboard window: the 1st of the current WIB month through today. */
export function currentMonthRange(today = wibDate()): { from: string; to: string } {
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

export function previousMonthRange(today = wibDate()): { from: string; to: string } {
  const [year, month] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 2, 1));
  const end = new Date(Date.UTC(year, month - 1, 0));
  const iso = (stamp: Date) => stamp.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end) };
}

/** Same-length window immediately before the chosen period. */
export function previousEqualWindow(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const prevEnd = start - 86400000;
  const prevStart = prevEnd - (days - 1) * 86400000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(prevStart), to: iso(prevEnd) };
}

export function lastNDays(days: number, today = wibDate()): { from: string; to: string } {
  return { from: shiftDay(today, -(days - 1)), to: today };
}

/** Status-only changes keep Tgl Updated. Returned/Canceled and any other change refresh it. */
export function shouldRefreshContentUpdated(changes: { field: string }[], nextStatus: string): boolean {
  if (!changes.length) return false;
  const statusOnly = changes.every((change) => change.field === "header.status");
  if (!statusOnly) return true;
  const status = nextStatus.trim().toUpperCase();
  return status === "RETURNED" || status === "CANCELED" || status === "CANCELLED" || status === "CANCEL";
}

export function lossParentNo(noPesanan: string): string | null {
  return /-R$/i.test(noPesanan) ? noPesanan.replace(/-R$/i, "") : null;
}

export function isLossSiblingOrder(input: { noPesanan: string; channel: string; storeName: string }): boolean {
  return Boolean(lossParentNo(input.noPesanan)) && /internal/i.test(input.channel) && /barang hilang/i.test(input.storeName);
}

export function carryOrderMeta(previous: OrderVersion | null, next: OrderVersion, changes: { field: string }[]): void {
  const loss = isLossSiblingOrder(next);
  next.lossSibling = loss;
  next.parentNoPesanan = previous?.parentNoPesanan || lossParentNo(next.noPesanan);
  next.dataStatus = previous?.dataStatus ?? "active";
  const returned = next.status.trim().toUpperCase() === "RETURNED";
  next.returnCase = returned ? (previous?.returnCase ?? next.returnCase ?? null) : null;
  if (!previous) {
    next.contentUpdatedAt = next.createdAt;
    return;
  }
  next.contentUpdatedAt = shouldRefreshContentUpdated(changes, next.status)
    ? next.createdAt
    : (previous.contentUpdatedAt || previous.createdAt);
}

export function booksClosed(orderDay: string, ppnReportDate: string | null | undefined): boolean {
  if (!ppnReportDate || !orderDay) return false;
  return orderDay.slice(0, 10) <= ppnReportDate.slice(0, 10);
}

export function canSoftDeleteOrder(input: { synced: boolean }): { ok: boolean; reason?: string } {
  if (input.synced) {
    return {
      ok: false,
      reason: "Pesanan yang sudah sync ke Accurate tidak bisa dihapus. Ubah status ke CANCELED atau RETURNED, lalu sync.",
    };
  }
  return { ok: true };
}

export type AccurateIntentLabel =
  | "Buat penjualan"
  | "Ubah penjualan"
  | "Hapus penjualan"
  | "Buat Retur penjualan"
  | "Tidak diproses otomatis"
  | "Tidak dikirim";

export function accurateIntent(input: {
  status: string;
  everSynced: boolean;
  orderDay: string;
  ppnReportDate?: string | null;
}): { label: AccurateIntentLabel; send: boolean } {
  const status = input.status.trim().toUpperCase();
  const closed = booksClosed(input.orderDay, input.ppnReportDate);
  const cancel = status === "CANCELED" || status === "CANCELLED" || status === "CANCEL";
  const returned = status === "RETURNED";
  if ((cancel || returned) && !input.everSynced) return { label: "Tidak dikirim", send: false };
  if (cancel && closed) return { label: "Tidak diproses otomatis", send: false };
  if (cancel) return { label: "Hapus penjualan", send: false };
  if (returned && closed) return { label: "Buat Retur penjualan", send: false };
  if (returned) return { label: "Hapus penjualan", send: false };
  if (!input.everSynced) return { label: "Buat penjualan", send: true };
  return { label: "Ubah penjualan", send: true };
}

export function inSyncQueue(input: {
  dataStatus?: string | null;
  category: string;
  contentUpdatedAt?: string | null;
  syncedAt?: string | null;
  ignored?: boolean;
}): boolean {
  if (input.dataStatus === "deleted") return false;
  if (input.ignored) return false;
  if (input.category === "Status saja" || input.category === "Sama") return false;
  if (input.contentUpdatedAt && input.syncedAt && input.contentUpdatedAt <= input.syncedAt) return false;
  return input.category === "Baru" || input.category === "Berubah" || input.category === "Returned" || input.category === "Batal";
}

export function isMappingPending(row: { mappedAt?: string | null; needsReview?: boolean; official?: string; channel?: string; store?: string }): boolean {
  if (typeof row.mappedAt === "string" && row.mappedAt) return false;
  if (row.mappedAt === null) return true;
  if (row.needsReview) return true;
  if ("official" in row) return !String(row.official ?? "").trim();
  return !String(row.channel ?? "").trim() || !String(row.store ?? "").trim();
}

/** A weight saved before the column existed counts as decided. An explicit empty date is pending. */
export function isBundlePending(row: { confirmedAt?: string | null }): boolean {
  if (typeof row.confirmedAt === "string" && row.confirmedAt) return false;
  return row.confirmedAt === null;
}

export function salesPushEnabled(value = process.env.ACCURATE_SALES_PUSH): boolean {
  return value === "enabled";
}

export const PAGE_SIZE = 25;

export const LOSS_CHANNEL = "Internal";
export const LOSS_STORE = "Barang Hilang";

export function buildReturnVersions(
  previous: OrderVersion,
  sibling: OrderVersion | null,
  input: { status: string; returnCase: ReturnCase | null; lost: { sku: string; qty: number }[]; by: string | null; now: string },
): { versions: OrderVersion[]; error?: string } {
  const status = input.status.trim().toUpperCase();
  if (status !== "RETURNED" && status !== "CANCELED" && status !== "CANCELLED") {
    return { versions: [], error: "Pilih status RETURNED atau CANCELED." };
  }
  if (status === "RETURNED" && (input.returnCase !== 1 && input.returnCase !== 2 && input.returnCase !== 3)) {
    return { versions: [], error: "Retur wajib memilih Case 1, 2, atau 3." };
  }
  const lost = input.lost.filter((line) => line.sku && line.qty > 0);
  if (status === "RETURNED" && input.returnCase === 2 && !lost.length) {
    return { versions: [], error: "Case 2 wajib mengisi produk yang hilang." };
  }
  const original: OrderVersion = {
    ...previous,
    id: crypto.randomUUID(),
    versionNo: previous.versionNo + 1,
    importId: null,
    source: "manual_edit",
    createdAt: input.now,
    createdBy: input.by,
    isCurrent: true,
    status: status === "RETURNED" ? "RETURNED" : "CANCELED",
    contentUpdatedAt: input.now,
    returnCase: status === "RETURNED" ? input.returnCase : null,
    lines: previous.lines.map((line) => ({ ...line, id: crypto.randomUUID() })),
  };
  const versions = [original];
  if (status !== "RETURNED" || input.returnCase === 1) return { versions };
  const sourceLines = input.returnCase === 3
    ? previous.lines.map((line) => ({ sku: line.sku, qty: line.qty, name: line.productName }))
    : lost.map((line) => {
      const match = previous.lines.find((item) => item.sku === line.sku);
      return { sku: line.sku, qty: line.qty, name: match?.productName ?? line.sku };
    });
  const no = `${previous.noPesanan}-R`;
  const base = sibling ?? previous;
  const siblingVersion: OrderVersion = {
    ...base,
    id: crypto.randomUUID(),
    noPesanan: no,
    versionNo: sibling ? sibling.versionNo + 1 : 1,
    importId: null,
    source: "manual_edit",
    createdAt: input.now,
    createdBy: input.by,
    isCurrent: true,
    channel: LOSS_CHANNEL,
    storeName: LOSS_STORE,
    status: "COMPLETED",
    customerName: previous.customerName,
    customerCode: previous.customerCode,
    province: previous.province,
    city: previous.city,
    kurir: "—",
    tanggal: input.now,
    day: input.now.slice(0, 10),
    totalDiskon: 0,
    totalNilaiPesanan: 0,
    revenue: 0,
    qty: sourceLines.reduce((sum, line) => sum + line.qty, 0),
    contentUpdatedAt: input.now,
    dataStatus: "active",
    returnCase: null,
    parentNoPesanan: previous.noPesanan,
    lossSibling: true,
    lines: sourceLines.map((line) => ({
      id: crypto.randomUUID(),
      sku: line.sku,
      productName: line.name,
      qty: line.qty,
      unitPrice: 0,
      subTotal: 0,
      unitDiskon: 0,
      revenuePerUnit: 0,
      missingWeight: false,
      bundleKey: null,
      unitCogs: null,
      flags: [],
    })),
  };
  versions.push(siblingVersion);
  return { versions };
}
