import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rapikan, type CleanLine } from "@/lib/cleanup/rapikan";
import {
  channelMap,
  cityMap,
  provinceMap,
  readCleanWorkbook,
  readSalesWorkbook,
  readChannelStoreWorkbook,
  readCityWorkbook,
  readProvinceWorkbook,
  readWeightWorkbook,
  weightMap,
} from "@/lib/cleanup/read-xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function loadMaps() {
  return {
    weights: weightMap(readWeightWorkbook(readFileSync(path.join(root, "samples/bobot-bundle.xlsx")))),
    channels: channelMap(readChannelStoreWorkbook(readFileSync(path.join(root, "samples/mapping-channel-toko.xlsx")))),
    provinces: provinceMap(readProvinceWorkbook(readFileSync(path.join(root, "samples/mapping-provinsi.xlsx")))),
    cities: cityMap(readCityWorkbook(readFileSync(path.join(root, "samples/mapping-kota.xlsx")))),
  };
}

const STRING_FIELDS = [
  "noPesanan",
  "channel",
  "storeName",
  "sku",
  "customerName",
  "customerCode",
  "province",
  "city",
  "kurir",
] as const;

const NUMBER_FIELDS = [
  "qty",
  "unitPrice",
  "subTotal",
  "totalNilaiPesanan",
  "totalDiskon",
  "unitDiskon",
  "revenuePerUnit",
] as const;

function compareLines(got: CleanLine[], expected: CleanLine[], label: string) {
  expect(got, label).toHaveLength(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i += 1) {
    const row = got[i];
    const exp = expected[i];
    expect(row.tanggal.slice(0, 19), `${label} row ${i} tanggal`).toBe(exp.tanggal.slice(0, 19));
    expect(row.day, `${label} row ${i} day`).toBe(exp.day);
    for (const field of STRING_FIELDS) {
      expect(row[field], `${label} row ${i} ${field} ${row.noPesanan} ${row.sku}`).toBe(exp[field]);
    }
    for (const field of NUMBER_FIELDS) {
      const diff = Math.abs((row[field] ?? 0) - (exp[field] ?? 0));
      worst = Math.max(worst, diff);
      expect(diff, `${label} row ${i} ${field} got ${row[field]} exp ${exp[field]}`).toBeLessThan(1e-6);
    }
  }
  expect(worst, label).toBeLessThan(1e-6);
}

describe("rapikan parity", () => {
  const raw = readSalesWorkbook(readFileSync(path.join(root, "samples/laporan-penjualan-2026-10-27-30-raw.xlsx")));
  const maps = loadMaps();

  it("matches Rapi_Penjualan 2026-10-28", () => {
    const result = rapikan(raw, maps, { from: "2026-10-28", to: "2026-10-28" });
    const expected = readCleanWorkbook(readFileSync(path.join(root, "samples/rapi-penjualan-2026-10-28.xlsx")));
    compareLines(result.lines, expected, "2026-10-28");
  });

  it("matches Rapi_Penjualan 2026-10-29", () => {
    const result = rapikan(raw, maps, { from: "2026-10-29", to: "2026-10-29" });
    const expected = readCleanWorkbook(readFileSync(path.join(root, "samples/rapi-penjualan-2026-10-29.xlsx")));
    compareLines(result.lines, expected, "2026-10-29");
  });

  it("keeps RETURNED and drops Pending, Paid, and Cancel", () => {
    const result = rapikan(raw, maps, { from: "2026-10-28", to: "2026-10-29" });
    expect(result.lines.every((line) => !["PENDING", "PAID", "CANCELED", "CANCELLED", "CANCEL"].includes(line.status.toUpperCase()))).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
  });
});
