import type { DashboardQuery, DashboardReport, GroupRow } from "@/lib/db/types";
import { bucketLabel, bucketOf } from "@/lib/domain/aggregate";
import { inclusiveDays } from "@/lib/marketing/dates";

export type SpendSlice = {
  storeName: string;
  periodStart: string;
  periodEnd: string;
  spend: number;
  platform?: string;
  adsRevenue?: number | null;
};

export type MarketingLine = {
  store: string;
  platform: string;
  spend: number;
  adsRevenue: number | null;
  channels: string[];
  targetNet: number;
  targetHpp: number;
  targetFee: number;
};

const CHANNEL_LABEL: Record<string, string> = {
  shopee: "Shopee",
  tiktok: "Tiktok",
  tokopedia: "Tokopedia",
  lazada: "Lazada",
  blibli: "BliBli",
};

/** Ad platforms that land on one channel, or the TikTok + Tokopedia pair. Empty means not allocated to a channel. */
export function platformTargetKeys(platform: string): string[] {
  const key = platform.trim().toLowerCase();
  if (key === "tiktok ads" || key.includes("gmv")) return ["tiktok", "tokopedia"];
  if (key === "shopee ads" || key === "cpas" || key === "meta ads") return ["shopee"];
  if (key === "lazada ads") return ["lazada"];
  if (key === "blibli ads") return ["blibli"];
  return [];
}

export function overlapFactor(periodStart: string, periodEnd: string, from: string | null, to: string | null): number {
  const start = from && from > periodStart ? from : periodStart;
  const end = to && to < periodEnd ? to : periodEnd;
  if (end < start) return 0;
  const total = inclusiveDays(periodStart, periodEnd);
  if (total <= 0) return 0;
  return inclusiveDays(start, end) / total;
}

function nextIso(day: string): string {
  const stamp = new Date(`${day}T00:00:00Z`);
  stamp.setUTCDate(stamp.getUTCDate() + 1);
  return stamp.toISOString().slice(0, 10);
}

/** Profit bersih: revenue bersih − HPP − biaya platform − marketing. */
export function storeProfit(net: number, hpp: number, fee: number, marketing: number): number {
  return net - hpp - fee - marketing;
}

/** Kontribusi sebelum HPP: revenue bersih − biaya platform − marketing. */
export function contributionBeforeHpp(net: number, fee: number, marketing: number): number {
  return net - fee - marketing;
}

/** Share of marketplace net that has a fee row. Null when the row is not a marketplace mix. */
export function feeCoverageRatio(mpNet: number, mpCovered: number): number | null {
  if (!(mpNet > 0)) return null;
  return mpCovered / mpNet;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function splitWeighted(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const shares = sum > 0 ? weights.map((weight) => weight / sum) : weights.map(() => 1 / weights.length);
  const parts = shares.map((share) => round2(total * share));
  const drift = round2(total - parts.reduce((acc, part) => acc + part, 0));
  parts[parts.length - 1] = round2((parts[parts.length - 1] ?? 0) + drift);
  return parts;
}

function visibleChannel(channel: string, channels: string[]): boolean {
  if (!channels.length) return true;
  const want = new Set(channels.map((item) => item.toLowerCase()));
  return want.has(channel.toLowerCase());
}

type ShareRow = { store: string; channel: string; net: number; hpp: number; fee: number };

function shareRows(report: DashboardReport): ShareRow[] {
  if (report.allocBase?.length) {
    return report.allocBase.map((row) => ({
      store: row.store,
      channel: row.channel,
      net: row.net,
      hpp: row.hpp ?? 0,
      fee: row.fee ?? 0,
    }));
  }
  if (report.matrix?.length) {
    return report.matrix.map((row) => ({
      store: row.store,
      channel: row.channel,
      net: row.net,
      hpp: row.hpp ?? 0,
      fee: row.fee ?? 0,
    }));
  }
  return [];
}

function channelLabel(store: string, key: string, shares: ShareRow[]): string {
  const hit = shares.find((row) => row.store.toLowerCase() === store.toLowerCase() && row.channel.toLowerCase() === key);
  return hit?.channel || CHANNEL_LABEL[key] || key;
}

function applyLegacy(report: DashboardReport, spends: SpendSlice[], query: Pick<DashboardQuery, "from" | "to" | "stores" | "granularity">): DashboardReport {
  const wanted = new Set((query.stores ?? []).map((store) => store.toLowerCase()));
  const byStore = new Map<string, { name: string; amount: number }>();
  const byBucket = new Map<string, number>();
  const through = new Map<string, string>();
  let total = 0;
  let last = "";
  for (const row of spends) {
    if (wanted.size && !wanted.has(row.storeName.toLowerCase())) continue;
    const factor = overlapFactor(row.periodStart, row.periodEnd, query.from, query.to);
    if (factor <= 0) continue;
    total += row.spend * factor;
    const key = row.storeName.toLowerCase();
    const entry = byStore.get(key) ?? { name: row.storeName, amount: 0 };
    entry.amount += row.spend * factor;
    byStore.set(key, entry);
    if (row.periodEnd > (through.get(key) ?? "")) through.set(key, row.periodEnd);
    if (row.periodEnd > last) last = row.periodEnd;
    const periodDays = inclusiveDays(row.periodStart, row.periodEnd);
    if (!periodDays || !query.granularity) continue;
    const daily = row.spend / periodDays;
    let day = query.from && query.from > row.periodStart ? query.from : row.periodStart;
    const end = query.to && query.to < row.periodEnd ? query.to : row.periodEnd;
    while (day <= end) {
      const bucket = bucketOf(day, query.granularity);
      if (bucket) byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + daily);
      day = nextIso(day);
    }
  }
  const stores: GroupRow[] = report.stores.map((store) => {
    const hit = byStore.get(store.key.toLowerCase());
    const marketing = round2(hit?.amount ?? 0);
    if (hit) byStore.delete(store.key.toLowerCase());
    return { ...store, marketing };
  });
  for (const { name, amount } of byStore.values()) {
    const marketing = round2(amount);
    if (!marketing) continue;
    stores.push({ key: name, gross: 0, net: 0, hpp: 0, fee: 0, profit: 0, qty: 0, orders: 0, marketing });
  }
  const granularity = query.granularity ?? "day";
  const trend = report.trend.map((row) => ({ ...row, marketing: round2(byBucket.get(row.bucket) ?? 0) }));
  const seen = new Set(trend.map((row) => row.bucket));
  for (const [bucket, amount] of byBucket) {
    const marketing = round2(amount);
    if (!bucket || seen.has(bucket) || !marketing) continue;
    trend.push({ bucket, label: bucketLabel(bucket, granularity), gross: 0, net: 0, orders: 0, hpp: 0, profit: 0, marketing });
  }
  trend.sort((a, b) => a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0);
  const marketingThroughByStore: Record<string, string> = {};
  for (const store of stores) {
    const end = through.get(store.key.toLowerCase());
    if (end) marketingThroughByStore[store.key] = end;
  }
  return {
    ...report,
    kpis: { ...report.kpis, marketing: round2(total) },
    stores,
    trend,
    marketingLines: [],
    marketingThrough: last || null,
    marketingThroughByStore,
  };
}

export function applyMarketingAllocation(
  report: DashboardReport,
  spends: SpendSlice[],
  query: Pick<DashboardQuery, "from" | "to" | "stores" | "granularity"> & { channels?: string[] },
): DashboardReport {
  if (!spends.some((row) => row.platform)) return applyLegacy(report, spends, query);
  const wanted = new Set((query.stores ?? []).map((store) => store.toLowerCase()));
  const channels = query.channels ?? [];
  const shares = shareRows(report);
  const byCell = new Map<string, number>();
  const byStore = new Map<string, { name: string; amount: number }>();
  const byChannel = new Map<string, { name: string; amount: number }>();
  const byBucket = new Map<string, number>();
  const through = new Map<string, string>();
  const lineMap = new Map<string, MarketingLine & { hasAds: boolean }>();
  let total = 0;
  let last = "";

  function cellKey(store: string, channel: string): string {
    return `${store.toLowerCase()}\0${channel.toLowerCase()}`;
  }

  function addStore(name: string, amount: number) {
    const key = name.toLowerCase();
    const entry = byStore.get(key) ?? { name, amount: 0 };
    entry.amount += amount;
    byStore.set(key, entry);
  }

  function addChannel(name: string, amount: number) {
    const key = name.toLowerCase();
    const entry = byChannel.get(key) ?? { name, amount: 0 };
    entry.amount += amount;
    byChannel.set(key, entry);
  }

  for (const row of spends) {
    if (wanted.size && !wanted.has(row.storeName.toLowerCase())) continue;
    const factor = overlapFactor(row.periodStart, row.periodEnd, query.from, query.to);
    if (factor <= 0 || !row.spend) continue;
    const amount = row.spend * factor;
    const targets = platformTargetKeys(row.platform ?? "");
    const labels = targets.map((key) => channelLabel(row.storeName, key, shares));
    const weights = labels.map((label) => {
      const hit = shares.find((share) => share.store.toLowerCase() === row.storeName.toLowerCase() && share.channel.toLowerCase() === label.toLowerCase());
      return Math.max(0, hit?.net ?? 0);
    });
    const parts = labels.length ? splitWeighted(round2(amount), weights) : [];
    let visibleSpend = 0;
    const placed: string[] = [];
    labels.forEach((label, index) => {
      const part = parts[index] ?? 0;
      if (!part || !visibleChannel(label, channels)) return;
      visibleSpend += part;
      placed.push(label);
      byCell.set(cellKey(row.storeName, label), (byCell.get(cellKey(row.storeName, label)) ?? 0) + part);
      addChannel(label, part);
    });
    if (!labels.length && visibleChannel("Tidak dialokasikan", channels)) {
      const part = round2(amount);
      if (part) {
        visibleSpend += part;
        placed.push("Tidak dialokasikan");
        byCell.set(cellKey(row.storeName, "Tidak dialokasikan"), (byCell.get(cellKey(row.storeName, "Tidak dialokasikan")) ?? 0) + part);
        addChannel("Tidak dialokasikan", part);
      }
    }
    if (visibleSpend) {
      addStore(row.storeName, visibleSpend);
      if (row.periodEnd > (through.get(row.storeName.toLowerCase()) ?? "")) through.set(row.storeName.toLowerCase(), row.periodEnd);
      if (row.periodEnd > last) last = row.periodEnd;
    }
    total += visibleSpend;

    const lineKey = `${row.storeName.toLowerCase()}\0${(row.platform ?? "").toLowerCase()}`;
    const line = lineMap.get(lineKey) ?? {
      store: row.storeName,
      platform: row.platform ?? "",
      spend: 0,
      adsRevenue: null,
      hasAds: false,
      channels: [],
      targetNet: 0,
      targetHpp: 0,
      targetFee: 0,
    };
    line.spend += visibleSpend;
    const basis = round2(amount);
    if (row.adsRevenue != null && visibleSpend && basis) {
      line.hasAds = true;
      line.adsRevenue = (line.adsRevenue ?? 0) + row.adsRevenue * factor * (visibleSpend / basis);
    }
    if (placed.length) {
      line.channels = placed;
      let targetNet = 0;
      let targetHpp = 0;
      let targetFee = 0;
      for (const label of placed) {
        const hit = shares.find((share) => share.store.toLowerCase() === row.storeName.toLowerCase() && share.channel.toLowerCase() === label.toLowerCase());
        targetNet += hit?.net ?? 0;
        targetHpp += hit?.hpp ?? 0;
        targetFee += hit?.fee ?? 0;
      }
      line.targetNet = targetNet;
      line.targetHpp = targetHpp;
      line.targetFee = targetFee;
    }
    if (visibleSpend) lineMap.set(lineKey, line);

    const periodDays = inclusiveDays(row.periodStart, row.periodEnd);
    if (!periodDays || !query.granularity || !visibleSpend) continue;
    const daily = visibleSpend / inclusiveDays(
      query.from && query.from > row.periodStart ? query.from : row.periodStart,
      query.to && query.to < row.periodEnd ? query.to : row.periodEnd,
    );
    let day = query.from && query.from > row.periodStart ? query.from : row.periodStart;
    const end = query.to && query.to < row.periodEnd ? query.to : row.periodEnd;
    while (day <= end) {
      const bucket = bucketOf(day, query.granularity);
      if (bucket) byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + daily);
      day = nextIso(day);
    }
  }

  const stores: GroupRow[] = report.stores.map((store) => {
    const hit = byStore.get(store.key.toLowerCase());
    if (hit) byStore.delete(store.key.toLowerCase());
    return { ...store, marketing: round2(hit?.amount ?? 0) };
  });
  for (const { name, amount } of byStore.values()) {
    const marketing = round2(amount);
    if (!marketing) continue;
    stores.push({ key: name, gross: 0, net: 0, hpp: 0, fee: 0, profit: 0, qty: 0, orders: 0, marketing });
  }
  const channelRows: GroupRow[] = report.channels.map((row) => {
    const hit = byChannel.get(row.key.toLowerCase());
    if (hit) byChannel.delete(row.key.toLowerCase());
    return { ...row, marketing: round2(hit?.amount ?? 0) };
  });
  for (const { name, amount } of byChannel.values()) {
    const marketing = round2(amount);
    if (!marketing) continue;
    channelRows.push({ key: name, gross: 0, net: 0, hpp: 0, fee: 0, profit: 0, qty: 0, orders: 0, marketing });
  }
  const matrix = (report.matrix ?? []).map((row) => ({
    ...row,
    marketing: round2(byCell.get(cellKey(row.store, row.channel)) ?? 0),
  }));
  const seenCells = new Set(matrix.map((row) => cellKey(row.store, row.channel)));
  for (const [key, amount] of byCell) {
    const marketing = round2(amount);
    if (!marketing || seenCells.has(key)) continue;
    const [storeKey, channelKey] = key.split("\0");
    const storeName = stores.find((row) => row.key.toLowerCase() === storeKey)?.key ?? storeKey;
    const channelName = channelRows.find((row) => row.key.toLowerCase() === channelKey)?.key ?? channelKey;
    matrix.push({
      store: storeName,
      channel: channelName,
      gross: 0,
      net: 0,
      hpp: 0,
      fee: 0,
      qty: 0,
      orders: 0,
      profit: 0,
      marketing,
      mpNet: 0,
      mpCovered: 0,
    });
  }
  const granularity = query.granularity ?? "day";
  const trend = report.trend.map((row) => ({ ...row, marketing: round2(byBucket.get(row.bucket) ?? 0) }));
  const seen = new Set(trend.map((row) => row.bucket));
  for (const [bucket, amount] of byBucket) {
    const marketing = round2(amount);
    if (!bucket || seen.has(bucket) || !marketing) continue;
    trend.push({ bucket, label: bucketLabel(bucket, granularity), gross: 0, net: 0, orders: 0, hpp: 0, fee: 0, profit: 0, marketing });
  }
  trend.sort((a, b) => a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0);
  const marketingThroughByStore: Record<string, string> = {};
  for (const store of stores) {
    const end = through.get(store.key.toLowerCase());
    if (end) marketingThroughByStore[store.key] = end;
  }
  const marketingLines: MarketingLine[] = [...lineMap.values()]
    .map((line) => ({
      store: line.store,
      platform: line.platform,
      spend: round2(line.spend),
      adsRevenue: line.hasAds && line.adsRevenue != null ? round2(line.adsRevenue) : null,
      channels: line.channels,
      targetNet: line.targetNet,
      targetHpp: line.targetHpp,
      targetFee: line.targetFee,
    }))
    .filter((line) => line.spend)
    .sort((a, b) => b.spend - a.spend);
  return {
    ...report,
    kpis: { ...report.kpis, marketing: round2(total) },
    stores,
    channels: channelRows,
    matrix,
    trend,
    marketingLines,
    marketingThrough: last || null,
    marketingThroughByStore,
  };
}
