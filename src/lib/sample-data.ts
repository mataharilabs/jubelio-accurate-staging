import { readFileSync } from "node:fs";
import path from "node:path";
import { rapikan, type CleanLine } from "@/lib/cleanup/rapikan";
import {
  channelMap,
  cityMap,
  provinceMap,
  readChannelStoreWorkbook,
  readCityWorkbook,
  readCleanWorkbook,
  readProvinceWorkbook,
  readSalesWorkbook,
  readWeightWorkbook,
  weightMap,
} from "@/lib/cleanup/read-xlsx";
import type { DataStore } from "@/lib/db/store";
import type { RapikanMaps } from "@/lib/cleanup/rapikan";

const root = process.cwd();

function file(name: string) {
  return readFileSync(path.join(root, "samples", name));
}

export async function rapikanMaps(store: DataStore): Promise<RapikanMaps> {
  const [weights, channels, provinces, cities] = await Promise.all([
    store.listWeights(),
    store.listChannelMaps(),
    store.listProvinceMaps(),
    store.listCityMaps(),
  ]);
  return {
    weights: weightMap(weights.map((row) => ({ bundleKey: row.bundleKey, bobot: row.bobot }))),
    channels: channelMap(channels.map((row) => ({
      channelRaw: row.channelRaw,
      storeRaw: row.storeRaw,
      channel: row.channel,
      store: row.store,
    }))),
    provinces: provinceMap(provinces.map((row) => ({ raw: row.raw, official: row.official, needsReview: row.needsReview }))),
    cities: cityMap(cities.map((row) => ({
      provinceRaw: row.provinceRaw,
      cityRaw: row.cityRaw,
      official: row.official,
      needsReview: row.needsReview,
    }))),
  };
}

export async function seedReferenceData(store: DataStore): Promise<void> {
  const weights = await store.listWeights();
  if (!weights.length) {
    await store.upsertWeights(readWeightWorkbook(file("bobot-bundle.xlsx")), false);
  }
  const channels = await store.listChannelMaps();
  if (!channels.length) {
    for (const row of readChannelStoreWorkbook(file("mapping-channel-toko.xlsx"))) {
      await store.saveChannelMap({ ...row, needsReview: false });
    }
  }
  const provinces = await store.listProvinceMaps();
  if (!provinces.length) {
    for (const row of readProvinceWorkbook(file("mapping-provinsi.xlsx"))) await store.saveProvinceMap(row);
  }
  const cities = await store.listCityMaps();
  if (!cities.length) {
    for (const row of readCityWorkbook(file("mapping-kota.xlsx"))) await store.saveCityMap(row);
  }
}

const SAMPLES = [
  "rapi-penjualan-2026-10-26.xlsx",
  "rapi-penjualan-2026-10-27.xlsx",
  "rapi-penjualan-2026-10-28.xlsx",
  "rapi-penjualan-2026-10-29.xlsx",
];

function enrich(lines: CleanLine[], reference: CleanLine[]): CleanLine[] {
  const status = new Map<string, string>();
  const names = new Map<string, string>();
  for (const line of reference) {
    if (line.status && (line.status.toUpperCase() === "RETURNED" || !status.has(line.noPesanan))) status.set(line.noPesanan, line.status);
    if (line.productName) names.set(line.sku, line.productName);
  }
  return lines.map((line) => ({
    ...line,
    status: line.status || status.get(line.noPesanan) || "",
    productName: line.productName || names.get(line.sku) || "",
  }));
}

export async function seedSampleSales(store: DataStore, by = "sistem"): Promise<void> {
  const maps = await rapikanMaps(store);
  const raw = rapikan(readSalesWorkbook(file("laporan-penjualan-2026-10-27-30-raw.xlsx")), maps);
  for (const name of SAMPLES) {
    const lines = enrich(readCleanWorkbook(file(name)), raw.lines);
    await store.importCleanLines(lines, `contoh:${name}`, "sample", by);
  }
}
