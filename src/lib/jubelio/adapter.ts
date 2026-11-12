import type { RawSalesRow } from "@/lib/cleanup/rapikan";

export const DEFAULT_JUBELIO_LOCATIONS = [
  "Lintas Jkt",
  "Lintas Jkt (Bazar)",
  "Lintas Jkt (Damaged)",
  "Lintas Jkt (Undefined)",
  "Lintas Sby",
  "Lintas Sby (Bazar)",
  "Lintas Sby (Damaged)",
  "Lintas Sby (Undefined)",
  "Lintas Sby (Tanjungsari)",
  "Pristine Aroma",
];

type BundleComponent = {
  item_id?: number;
  item_code?: string | null;
  item_name?: string | null;
  qty?: number | string | null;
  qty_in_base?: number | string | null;
};

export type BundleRecord = {
  item_id: number;
  bundles: BundleComponent[];
};

type ApiItem = {
  item_id?: number;
  item_code?: string | null;
  description?: string | null;
  item_name?: string | null;
  qty?: number | string | null;
  qty_in_base?: number | string | null;
  price?: number | string | null;
  amount?: number | string | null;
  loc_name?: string | null;
  is_bundle?: boolean;
};

export type ApiOrder = {
  salesorder_id: number;
  salesorder_no: string;
  transaction_date: string;
  picked_in?: number | null;
  ref_no?: string | null;
  source_name?: string | null;
  store_name?: string | null;
  shipping_full_name?: string | null;
  customer_name?: string | null;
  shipping_city?: string | null;
  shipping_province?: string | null;
  courier?: string | null;
  shipper?: string | null;
  internal_status?: string | null;
  total_disc?: number | string | null;
  add_disc?: number | string | null;
  service_fee?: number | string | null;
  add_fee?: number | string | null;
  total_tax?: number | string | null;
  shipping_cost?: number | string | null;
  insurance_cost?: number | string | null;
  sub_total?: number | string | null;
  grand_total?: number | string | null;
  location_name?: string | null;
  items: ApiItem[];
};

function num(value: unknown): number {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Calendar day in Asia/Jakarta for an ISO timestamp. */
export function wibDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts;
}

/** Inclusive WIB day as a UTC window (WIB = UTC+7). */
export function wibWindowUtc(day: string): { from: string; to: string } {
  const [year, month, date] = day.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, date, -7, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function wibDate(iso: string | null | undefined): Date | null {
  const day = wibDay(iso);
  if (!day || !iso) return null;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  const [hour, minute, second] = time.split(":").map(Number);
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date, hour, minute, second));
}

/** Same location rule for order lines and the product master seeded from those lines. */
export function itemMatchesLocations(
  item: { loc_name?: string | null },
  order: { location_name?: string | null },
  locations: readonly string[] | null | undefined,
): boolean {
  if (!locations) return true;
  const loc = item.loc_name || order.location_name || "";
  return locations.includes(loc);
}

export function orderToRawRows(order: ApiOrder, bundles: Map<number, BundleRecord>, options?: { date?: string | null; locations?: string[] | null }): { rows: RawSalesRow[]; missingBundles: string[] } {
  const tanggal = wibDate(order.transaction_date);
  if (options?.date && wibDay(order.transaction_date) !== options.date) return { rows: [], missingBundles: [] };
  const locations = options?.locations ?? null;
  const missing = new Set<string>();
  const rows: RawSalesRow[] = [];
  for (const item of order.items ?? []) {
    const loc = item.loc_name || order.location_name || null;
    if (!itemMatchesLocations(item, order, locations)) continue;
    const base: RawSalesRow = {
      tanggal,
      noPesanan: order.salesorder_no,
      ref: order.ref_no ?? null,
      channel: order.source_name ?? null,
      namaToko: order.store_name ?? null,
      pelanggan: order.shipping_full_name || order.customer_name || null,
      kota: order.shipping_city ?? null,
      provinsi: order.shipping_province ?? null,
      namaBarang: item.description || item.item_name || null,
      sku: item.item_code ?? null,
      qty: num(item.qty_in_base) || num(item.qty),
      hargaJual: num(item.price),
      itemCodeBundle: null,
      itemNameBundle: null,
      qtyBundle: 0,
      kurir: order.courier || order.shipper || null,
      lokasiGudang: loc,
      status: order.internal_status ?? null,
      totalPenjualanPerProduk: num(item.amount),
      diskon: num(order.total_disc),
      diskonLainnya: num(order.add_disc),
      biayaLainnya: num(order.add_fee),
    };
    if (item.is_bundle) {
      const components = item.item_id == null ? [] : (bundles.get(item.item_id)?.bundles ?? []);
      if (!components.length) {
        if (item.item_code) missing.add(item.item_code);
        rows.push(base);
        continue;
      }
      for (const component of components) {
        rows.push({
          ...base,
          itemCodeBundle: component.item_code ?? null,
          itemNameBundle: component.item_name ?? null,
          qtyBundle: num(component.qty),
        });
      }
    } else {
      rows.push(base);
    }
  }
  return { rows, missingBundles: [...missing].sort() };
}

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end && days.length < 62) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function recentDays(endDay: string, startOffset: number, endOffset: number): string[] {
  const end = new Date(`${endDay}T00:00:00Z`);
  const from = new Date(end);
  from.setUTCDate(from.getUTCDate() - startOffset);
  const to = new Date(end);
  to.setUTCDate(to.getUTCDate() - endOffset);
  return eachDay(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
}
