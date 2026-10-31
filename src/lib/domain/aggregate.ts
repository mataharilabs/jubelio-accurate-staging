import type { DashboardQuery, DashboardReport, GeoRow, GroupRow, OrderVersion, ProductRow } from "@/lib/db/types";

const BLN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

export function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  const stamp = new Date(Date.UTC(year, month - 1, date));
  return `${HARI[stamp.getUTCDay()]}, ${date} ${BLN[month - 1]}`;
}

export function dayShort(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  if (!month || !date) return day;
  return `${date} ${BLN[month - 1]}`;
}

export function bucketOf(day: string, granularity: DashboardQuery["granularity"]): string {
  if (!day) return "";
  if (granularity === "day") return day;
  if (granularity === "month") return day.slice(0, 7);
  const [year, month, date] = day.split("-").map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, date));
  const dw = (stamp.getUTCDay() + 6) % 7;
  stamp.setUTCDate(stamp.getUTCDate() - dw);
  return stamp.toISOString().slice(0, 10);
}

export function bucketLabel(bucket: string, granularity: DashboardQuery["granularity"]): string {
  if (granularity === "day") return dayLabel(bucket);
  if (granularity === "month") {
    const [year, month] = bucket.split("-").map(Number);
    return `${BLN[(month || 1) - 1]} ${year}`;
  }
  const [year, month, date] = bucket.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, date));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return `Mg ${start.getUTCDate()} ${BLN[start.getUTCMonth()]}–${end.getUTCDate()} ${BLN[end.getUTCMonth()]}`;
}

type Flat = {
  no: string;
  day: string;
  channel: string;
  store: string;
  province: string;
  city: string;
  status: string;
  kurir: string;
  sku: string;
  name: string;
  qty: number;
  gross: number;
  net: number;
};

function selected(list: string[] | undefined, value: string): boolean {
  return !list?.length || list.includes(value);
}

export function flattenCurrent(versions: OrderVersion[]): Flat[] {
  const rows: Flat[] = [];
  for (const version of versions) {
    if (!version.isCurrent || version.source === "cancel" || version.source === "manual_delete") continue;
    for (const line of version.lines) {
      rows.push({
        no: version.noPesanan,
        day: version.day,
        channel: version.channel,
        store: version.storeName,
        province: version.province,
        city: version.city,
        status: version.status,
        kurir: version.kurir,
        sku: line.sku,
        name: line.productName,
        qty: line.qty,
        gross: line.subTotal ?? 0,
        net: (line.revenuePerUnit ?? 0) * line.qty,
      });
    }
  }
  return rows;
}

export function filterFlat(rows: Flat[], query: DashboardQuery): Flat[] {
  return rows.filter((row) => {
    if (query.from && row.day < query.from) return false;
    if (query.to && row.day > query.to) return false;
    if (!selected(query.channels, row.channel)) return false;
    if (!selected(query.stores, row.store)) return false;
    if (!selected(query.provinces, row.province)) return false;
    if (!selected(query.cities, row.city)) return false;
    if (!selected(query.statuses, row.status)) return false;
    if (!selected(query.couriers, row.kurir)) return false;
    if (!selected(query.skus, row.sku)) return false;
    return true;
  });
}

function group(rows: Flat[], key: (row: Flat) => string): Map<string, { gross: number; net: number; qty: number; orders: Set<string>; name: string }> {
  const map = new Map<string, { gross: number; net: number; qty: number; orders: Set<string>; name: string }>();
  for (const row of rows) {
    const id = key(row);
    const item = map.get(id) ?? { gross: 0, net: 0, qty: 0, orders: new Set<string>(), name: row.name };
    item.gross += row.gross;
    item.net += row.net;
    item.qty += row.qty;
    item.orders.add(row.no);
    if (!item.name && row.name) item.name = row.name;
    map.set(id, item);
  }
  return map;
}

export function aggregate(rows: Flat[], query: DashboardQuery): DashboardReport {
  const orders = new Set(rows.map((row) => row.no));
  const gross = rows.reduce((sum, row) => sum + row.gross, 0);
  const net = rows.reduce((sum, row) => sum + row.net, 0);
  const qty = rows.reduce((sum, row) => sum + row.qty, 0);
  const days = new Set(rows.map((row) => row.day).filter(Boolean)).size;
  const trendMap = group(rows, (row) => bucketOf(row.day, query.granularity));
  const trend = [...trendMap.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([bucket, item]) => ({
      bucket,
      label: bucketLabel(bucket, query.granularity),
      gross: item.gross,
      net: item.net,
      orders: item.orders.size,
    }));
  const toGroup = (map: Map<string, { gross: number; net: number; qty: number; orders: Set<string> }>): GroupRow[] =>
    [...map.entries()]
      .map(([key, item]) => ({ key, gross: item.gross, net: item.net, qty: item.qty, orders: item.orders.size }))
      .sort((a, b) => b.gross - a.gross);
  const products: ProductRow[] = [...group(rows, (row) => row.sku).entries()]
    .map(([sku, item]) => ({
      key: sku,
      sku,
      name: item.name,
      gross: item.gross,
      net: item.net,
      qty: item.qty,
      orders: item.orders.size,
      share: net ? item.net / net : 0,
    }))
    .sort((a, b) => b.net - a.net);
  const geo = (key: (row: Flat) => string): GeoRow[] =>
    [...group(rows, key).entries()]
      .map(([name, item]) => ({ key: name, net: item.net, orders: item.orders.size, qty: item.qty, share: net ? item.net / net : 0 }))
      .sort((a, b) => b.net - a.net);
  return {
    kpis: {
      gross,
      disc: gross - net,
      net,
      orders: orders.size,
      qty,
      aov: orders.size ? net / orders.size : 0,
      days,
    },
    trend,
    channels: toGroup(group(rows, (row) => row.channel)),
    stores: toGroup(group(rows, (row) => row.store)),
    products,
    provinces: geo((row) => row.province),
    cities: geo((row) => row.city),
  };
}

export function reportOf(versions: OrderVersion[], query: DashboardQuery): DashboardReport {
  return aggregate(filterFlat(flattenCurrent(versions), query), query);
}
