/**
 * Port of the approved scripts/rapikan.py (v2, 17 columns).
 * Province/city/channel values that are not in the mapping tables are kept raw
 * and flagged. They are not fuzzy-matched.
 */

export const DROPPED_STATUSES = new Set(["PENDING", "PAID", "CANCELED", "CANCELLED", "CANCEL"]);
export const CANCEL_STATUSES = new Set(["CANCELED", "CANCELLED", "CANCEL"]);

const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u00a0]/g;

export const CLEAN_COLUMNS = [
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

export type RawSalesRow = {
  tanggal: Date | null;
  noPesanan: string | null;
  ref: string | null;
  channel: string | null;
  namaToko: string | null;
  pelanggan: string | null;
  kota: string | null;
  provinsi: string | null;
  namaBarang: string | null;
  sku: string | null;
  qty: number;
  hargaJual: number;
  itemCodeBundle: string | null;
  itemNameBundle: string | null;
  qtyBundle: number;
  kurir: string | null;
  lokasiGudang: string | null;
  status: string | null;
  totalPenjualanPerProduk: number;
  diskon: number;
  diskonLainnya: number;
  biayaLainnya: number;
};

export type ChannelStoreMapping = {
  channelRaw: string;
  storeRaw: string;
  channel: string;
  store: string;
};

export type ProvinceMapping = {
  raw: string;
  official: string;
  needsReview: boolean;
};

export type CityMapping = {
  provinceRaw: string;
  cityRaw: string;
  official: string;
  needsReview: boolean;
};

export type CleanLine = {
  tanggal: string;
  day: string;
  noPesanan: string;
  channel: string;
  storeName: string;
  sku: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
  subTotal: number | null;
  totalNilaiPesanan: number | null;
  totalDiskon: number;
  unitDiskon: number | null;
  revenuePerUnit: number | null;
  customerName: string;
  customerCode: string;
  province: string;
  city: string;
  kurir: string;
  status: string;
  lokasiGudang: string | null;
  missingWeight: boolean;
  bundleKey: string | null;
  flags: string[];
};

export type DroppedCancel = {
  noPesanan: string;
  status: string;
  tanggal: string | null;
  day: string | null;
};

export type CleanResult = {
  lines: CleanLine[];
  droppedCount: number;
  missingKeys: string[];
  droppedCancels: DroppedCancel[];
  unmappedChannels: { channel: string; store: string }[];
};

export type RapikanMaps = {
  weights: Map<string, number>;
  channels: Map<string, { channel: string; store: string }>;
  provinces: Map<string, ProvinceMapping>;
  cities: Map<string, CityMapping>;
};

const POS_CITY: { prefix: string; city: string; province: string }[] = [
  { prefix: "lintas sby", city: "Surabaya", province: "Jawa Timur" },
  { prefix: "lintas jkt", city: "Jakarta", province: "DKI Jakarta" },
];

export function normKey(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function channelStoreKey(channel: string, store: string, pos = false): string {
  return `${normKey(channel)}\u0000${pos ? "" : normKey(store)}`;
}

export function provinceKey(raw: string): string {
  return raw ?? "";
}

export function cityKey(provinceRaw: string, cityRaw: string): string {
  return `${provinceRaw ?? ""}\u0000${cityRaw ?? ""}`;
}

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
  const s = String(value);
  if (!s.trim()) return null;
  return s;
}

export function stripInvisible(value: string | null): string | null {
  if (value == null) return null;
  return value.replace(INVISIBLE, "");
}

export function customerCode(name: string | null | undefined): string {
  const letters = String(name ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return (letters + "XXX").slice(0, 3);
}

/** Wall-clock stamp stored as UTC components, rounded to the nearest second. */
export function wallClock(date: Date | null): { iso: string; day: string } | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  const rounded = new Date(Math.round(date.getTime() / 1000) * 1000);
  const iso = rounded.toISOString().replace(".000Z", "");
  return { iso, day: iso.slice(0, 10) };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

type Working = {
  tanggal: Date | null;
  noPesanan: string;
  channel: string;
  storeName: string;
  sku: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
  orderDisc: number;
  customerName: string;
  province: string;
  city: string;
  kurir: string;
  status: string;
  lokasiGudang: string | null;
  missingWeight: boolean;
  bundleKey: string | null;
  flags: string[];
  pos: boolean;
  provinceRawEmpty: boolean;
};

export function rapikan(rows: RawSalesRow[], maps: RapikanMaps, range?: { from?: string | null; to?: string | null }): CleanResult {
  const from = range?.from || null;
  const to = range?.to || null;
  const working: Working[] = [];
  let droppedCount = 0;
  const missing = new Set<string>();
  const unmappedChannelKeys = new Map<string, { channel: string; store: string }>();
  const cancelByOrder = new Map<string, DroppedCancel>();
  const keptOrders = new Set<string>();

  for (const row of rows) {
    const clock = wallClock(row.tanggal);
    if (clock && from && clock.day < from) continue;
    if (clock && to && clock.day > to) continue;
    if (!clock && (from || to)) continue;

    const status = text(row.status);
    const statusUp = (status ?? "").toUpperCase();
    const ref = stripInvisible(text(row.ref));
    const sumber = stripInvisible(text(row.noPesanan));
    const noPesanan = ref != null && ref.trim() !== "" ? ref : (sumber ?? "");

    if (status && DROPPED_STATUSES.has(statusUp)) {
      droppedCount += 1;
      if (noPesanan && CANCEL_STATUSES.has(statusUp) && !cancelByOrder.has(noPesanan)) {
        cancelByOrder.set(noPesanan, { noPesanan, status, tanggal: clock?.iso ?? null, day: clock?.day ?? null });
      }
      continue;
    }

    const skuRaw = stripInvisible(text(row.sku));
    const bundleRaw = stripInvisible(text(row.itemCodeBundle));
    const isBundle = bundleRaw != null && bundleRaw.trim() !== "";
    const bundleKey = isBundle ? `${(skuRaw ?? "").trim()}-${bundleRaw.trim()}` : null;
    const channelRaw = text(row.channel);
    const storeRaw = text(row.namaToko);
    const pos = (channelRaw ?? "").trim().toUpperCase() === "SHOPEE" ? false : (channelRaw ?? "").trim().toUpperCase() === "JUBELIO-POS";
    const shopee = (channelRaw ?? "").trim().toUpperCase() === "SHOPEE";
    const missingWeight = isBundle && (bundleKey == null || !maps.weights.has(bundleKey));
    const bobot = isBundle ? (bundleKey != null && maps.weights.has(bundleKey) ? maps.weights.get(bundleKey)! : null) : 1;
    if (missingWeight && bundleKey) missing.add(bundleKey);

    const qtyRaw = num(row.qty);
    const unitPrice = bobot == null
      ? null
      : finiteOrNull(shopee ? (row.totalPenjualanPerProduk * bobot) / qtyRaw : num(row.hargaJual) * bobot);
    const orderDisc = shopee ? num(row.diskonLainnya) : num(row.diskon) + num(row.diskonLainnya) + num(row.biayaLainnya);
    const qty = Math.trunc(isBundle ? num(row.qtyBundle) * qtyRaw : qtyRaw);

    const ck = channelStoreKey(channelRaw ?? "", storeRaw ?? "", pos);
    const hit = maps.channels.get(ck);
    const flags: string[] = [];
    if (!hit) {
      flags.push("channel");
      unmappedChannelKeys.set(ck, { channel: channelRaw ?? "", store: pos ? "" : (storeRaw ?? "") });
    }
    if (missingWeight) flags.push("bobot");

    const provRaw = text(row.provinsi) ?? "";
    const kotaRaw = text(row.kota) ?? "";
    const provMap = maps.provinces.get(provinceKey(provRaw));
    const cityMap = maps.cities.get(cityKey(provRaw, kotaRaw));
    const province = provMap && provMap.official ? provMap.official : provRaw;
    let city = cityMap && cityMap.official ? cityMap.official : kotaRaw;
    if (!provMap) flags.push("provinsi");
    if (!cityMap) {
      if (!kotaRaw.trim()) city = "Tanpa nama kota";
      else flags.push("kota");
    }
    if (provMap?.needsReview) flags.push("provinsi");
    if (cityMap?.needsReview) flags.push("kota");

    const productName = (isBundle ? text(row.itemNameBundle) : null) || text(row.namaBarang) || "";
    if (noPesanan) keptOrders.add(noPesanan);

    working.push({
      tanggal: row.tanggal,
      noPesanan,
      channel: hit ? hit.channel : (channelRaw ?? ""),
      storeName: hit ? hit.store : (storeRaw ?? ""),
      sku: (isBundle ? bundleRaw! : (skuRaw ?? "")).trim(),
      productName,
      qty,
      unitPrice,
      orderDisc,
      customerName: text(row.pelanggan) ?? "",
      province,
      city,
      kurir: text(row.kurir) ?? "",
      status: status ?? "",
      lokasiGudang: text(row.lokasiGudang),
      missingWeight,
      bundleKey,
      flags,
      pos,
      provinceRawEmpty: !provRaw.trim(),
    });
  }

  for (const row of working) {
    if (!row.pos) continue;
    const loc = (row.lokasiGudang ?? "").trim().toLowerCase();
    const hit = POS_CITY.find((item) => loc.startsWith(item.prefix));
    if (!hit) {
      if (loc) row.flags.push("pos-kota");
      continue;
    }
    row.city = hit.city;
    if (row.provinceRawEmpty) row.province = hit.province;
  }

  type Group = Working & { sub: number | null; count: number };
  const groups = new Map<string, Group>();
  for (const row of working) {
    const key = `${row.noPesanan}\u0000${row.sku}`;
    const sub = row.unitPrice == null ? null : row.qty * row.unitPrice;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, sub, count: 1, flags: [...row.flags] });
      continue;
    }
    existing.qty += row.qty;
    existing.count += 1;
    if (existing.sub == null || sub == null) existing.sub = null;
    else existing.sub += sub;
    if (row.missingWeight) existing.missingWeight = true;
    for (const flag of row.flags) if (!existing.flags.includes(flag)) existing.flags.push(flag);
    if (row.status.toUpperCase() === "RETURNED") existing.status = row.status;
  }

  const merged: (Group & { unitPrice: number | null })[] = [];
  for (const group of groups.values()) {
    const unitPrice = group.sub == null ? null : group.qty !== 0 ? group.sub / group.qty : 0;
    merged.push({ ...group, unitPrice });
  }

  const orderSub = new Map<string, number | null>();
  const orderStatus = new Map<string, string>();
  for (const row of merged) {
    const prev = orderSub.get(row.noPesanan);
    if (prev === undefined) orderSub.set(row.noPesanan, row.sub);
    else if (prev == null || row.sub == null) orderSub.set(row.noPesanan, null);
    else orderSub.set(row.noPesanan, prev + row.sub);
    const st = orderStatus.get(row.noPesanan);
    if (!st || row.status.toUpperCase() === "RETURNED") orderStatus.set(row.noPesanan, row.status);
  }

  const lines: CleanLine[] = merged.map((row) => {
    const total = orderSub.get(row.noPesanan) ?? null;
    const status = orderStatus.get(row.noPesanan) ?? row.status;
    const unitDiskon = total == null
      ? null
      : total !== 0 && row.qty !== 0
        ? (row.sub! / total) * row.orderDisc / row.qty
        : 0;
    const revenue = row.unitPrice == null || unitDiskon == null ? null : row.unitPrice - unitDiskon;
    const clock = wallClock(row.tanggal);
    return {
      tanggal: clock?.iso ?? "",
      day: clock?.day ?? "",
      noPesanan: row.noPesanan,
      channel: row.channel,
      storeName: row.storeName,
      sku: row.sku,
      productName: row.productName,
      qty: row.qty,
      unitPrice: row.unitPrice,
      subTotal: row.sub,
      totalNilaiPesanan: total,
      totalDiskon: row.orderDisc,
      unitDiskon,
      revenuePerUnit: revenue,
      customerName: row.customerName,
      customerCode: customerCode(row.customerName),
      province: row.province,
      city: row.city,
      kurir: row.kurir,
      status,
      lokasiGudang: row.lokasiGudang,
      missingWeight: row.missingWeight,
      bundleKey: row.bundleKey,
      flags: [...new Set(row.flags)],
    };
  });

  const droppedCancels = [...cancelByOrder.values()].filter((row) => !keptOrders.has(row.noPesanan));
  return {
    lines,
    droppedCount,
    missingKeys: [...missing].sort(),
    droppedCancels,
    unmappedChannels: [...unmappedChannelKeys.values()],
  };
}

/** Recompute order money after a manual edit. Total Diskon stays at order level. */
export function recomputeLines<T extends { qty: number; unitPrice: number | null }>(
  lines: T[],
  totalDiskon: number,
): (T & { subTotal: number | null; totalNilaiPesanan: number | null; totalDiskon: number; unitDiskon: number | null; revenuePerUnit: number | null })[] {
  const subs = lines.map((line) => (line.unitPrice == null ? null : line.qty * line.unitPrice));
  const total = subs.some((value) => value == null) ? null : subs.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return lines.map((line, index) => {
    const subTotal = subs[index];
    const unitDiskon = total == null
      ? null
      : total !== 0 && line.qty !== 0 && subTotal != null
        ? (subTotal / total) * totalDiskon / line.qty
        : 0;
    return {
      ...line,
      subTotal,
      totalNilaiPesanan: total,
      totalDiskon,
      unitDiskon,
      revenuePerUnit: line.unitPrice == null || unitDiskon == null ? null : line.unitPrice - unitDiskon,
    };
  });
}
