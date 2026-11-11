import { customerCode } from "@/lib/cleanup/rapikan";
import type { OrderLine, OrderVersion } from "@/lib/db/types";
import { orderRevenue } from "@/lib/domain/orders";
import { AppError } from "@/lib/errors";

export type ManualLineInput = {
  sku: string;
  qty: number;
  unitPrice: number;
  unitDiskon: number;
};

export type ManualOrderInput = {
  noPesanan: string;
  tanggal: string;
  channel: string;
  storeName: string;
  customerName: string;
  status: string;
  province: string;
  city: string;
  kurir: string;
  lines: ManualLineInput[];
};

/** Datetime from the form is a WIB wall clock. The order day is that calendar date. */
export function manualTimestamp(value: string): { iso: string; day: string } | null {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return null;
  const day = match[1];
  const hour = Number(match[2] ?? "0");
  const minute = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59) return null;
  const iso = new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`).toISOString();
  if (Number.isNaN(Date.parse(iso))) return null;
  return { iso, day };
}

/**
 * Revenue uses the same per-unit formula as a Jubelio line after rapikan:
 * revenue per unit = harga satuan − diskon per unit.
 * HPP is not stored here. The order page and dashboard look it up from the
 * SKU and the order day, including PPN, the same way as a Jubelio order.
 */
export function buildManualOrder(
  input: ManualOrderInput,
  products: ReadonlyMap<string, string>,
  meta: { id?: string; createdAt: string; createdBy: string | null },
): OrderVersion {
  const noPesanan = input.noPesanan.trim();
  if (!noPesanan) throw new AppError("No pesanan wajib diisi.");
  const clock = manualTimestamp(input.tanggal);
  if (!clock) throw new AppError("Tanggal pesanan tidak valid.");
  const status = input.status.trim();
  if (!status) throw new AppError("Status pesanan wajib diisi.");
  if (!input.lines?.length) throw new AppError("Tambahkan minimal satu item.");
  const seen = new Set<string>();
  const lines: OrderLine[] = input.lines.map((line) => {
    const sku = String(line.sku ?? "").trim();
    if (!sku) throw new AppError("SKU wajib diisi.");
    if (seen.has(sku)) throw new AppError(`SKU ${sku} dobel di pesanan yang sama.`);
    seen.add(sku);
    if (!products.has(sku)) throw new AppError(`SKU ${sku} tidak ada di Master Produk.`);
    const qty = Number(line.qty);
    const unitPrice = Number(line.unitPrice);
    const unitDiskon = Number(line.unitDiskon ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) throw new AppError(`Qty SKU ${sku} harus lebih dari 0.`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new AppError(`Harga SKU ${sku} tidak valid.`);
    if (!Number.isFinite(unitDiskon) || unitDiskon < 0) throw new AppError(`Diskon SKU ${sku} tidak valid.`);
    if (unitDiskon > unitPrice) throw new AppError(`Diskon SKU ${sku} tidak boleh lebih besar dari harga.`);
    return {
      id: crypto.randomUUID(),
      sku,
      productName: products.get(sku) || sku,
      qty,
      unitPrice,
      subTotal: qty * unitPrice,
      unitDiskon,
      revenuePerUnit: unitPrice - unitDiskon,
      missingWeight: false,
      bundleKey: null,
      unitCogs: null,
      flags: [],
    };
  });
  const totalDiskon = lines.reduce((sum, line) => sum + (line.unitDiskon ?? 0) * line.qty, 0);
  return {
    id: meta.id ?? crypto.randomUUID(),
    noPesanan,
    versionNo: 1,
    importId: null,
    source: "manual",
    createdAt: meta.createdAt,
    createdBy: meta.createdBy,
    isCurrent: true,
    tanggal: clock.iso,
    day: clock.day,
    channel: input.channel.trim(),
    storeName: input.storeName.trim(),
    customerName: input.customerName.trim(),
    customerCode: customerCode(input.customerName),
    province: input.province.trim(),
    city: input.city.trim(),
    kurir: input.kurir.trim(),
    status,
    lokasiGudang: null,
    totalNilaiPesanan: lines.reduce((sum, line) => sum + (line.subTotal ?? 0), 0),
    totalDiskon,
    qty: lines.reduce((sum, line) => sum + line.qty, 0),
    revenue: orderRevenue(lines),
    lines,
    dataStatus: "active",
    contentUpdatedAt: meta.createdAt,
    returnCase: null,
    parentNoPesanan: null,
    lossSibling: false,
  };
}
