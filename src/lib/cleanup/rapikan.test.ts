import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rapikan, type RawSalesRow } from "@/lib/cleanup/rapikan";
import { readRapiWorkbook, readSalesWorkbook, readWeightWorkbook } from "@/lib/cleanup/read-xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rawPath = path.join(root, "samples/laporan-penjualan-2026-10-26-lintas-sby-jkt.xlsx");
const weightPath = path.join(root, "samples/bobot-bundle.xlsx");
const rapiPath = path.join(root, "samples/rapi-penjualan-2026-10-26-lintas-sby-jkt.xlsx");

describe("rapikan", () => {
  it("matches the Rapi workbook row for row", () => {
    const raw = readSalesWorkbook(readFileSync(rawPath));
    const weights = readWeightWorkbook(readFileSync(weightPath));
    const map = new Map(weights.map((row) => [row.bundleKey, row.bobot]));
    const result = rapikan(raw, map);
    const expected = readRapiWorkbook(readFileSync(rapiPath));

    expect(result.lines).toHaveLength(expected.length);
    expect(result.droppedCount).toBe(raw.length - expected.length);
    expect(result.missingKeys).toEqual([]);

    let worst = 0;
    for (let i = 0; i < expected.length; i += 1) {
      const got = result.lines[i];
      const exp = expected[i];
      expect(got.noPesanan, `row ${i} no pesanan`).toBe(exp.noPesanan);
      expect(got.channel, `row ${i} channel`).toBe(exp.channel);
      expect(got.sku, `row ${i} sku`).toBe(exp.sku);
      expect(got.qty, `row ${i} qty`).toBe(exp.qty);
      expect(got.hargaJual, `row ${i} harga`).not.toBeNull();
      expect(got.totalDiskon, `row ${i} diskon`).not.toBeNull();
      const hargaDiff = Math.abs((got.hargaJual ?? 0) - exp.hargaJual);
      const discDiff = Math.abs((got.totalDiskon ?? 0) - exp.totalDiskon);
      worst = Math.max(worst, hargaDiff, discDiff);
      expect(hargaDiff, `row ${i} harga diff`).toBeLessThan(1e-6);
      expect(discDiff, `row ${i} diskon diff`).toBeLessThan(1e-6);
    }
    expect(worst).toBeLessThan(1e-6);

    const gross = result.lines.reduce((sum, line) => sum + (line.hargaJual ?? 0), 0);
    const disc = result.lines.reduce((sum, line) => sum + (line.totalDiskon ?? 0), 0);
    expect(Math.round(gross)).toBe(35816279);
    expect(Math.round(disc)).toBe(10605775);

    const single = result.lines.find((line) => line.noPesanan === "261026M7VRKFSD" && line.sku === "NTMKCL001L");
    const bundle = result.lines.find((line) => line.noPesanan === "261026M2YTJ1YU" && line.sku === "40100083-01");
    expect(single?.qty).toBe(2);
    expect(single?.hargaJual).toBe(180000);
    expect(bundle?.qty).toBe(8);
    expect(bundle?.hargaJual).toBe(14500);
  });

  it("keeps bundle rows when the weight key is missing", () => {
    const row: RawSalesRow = {
      tanggal: "2026-10-26T00:00:00.000Z",
      noPesanan: "PO-1",
      ref: "REF-1",
      channel: "TOKOPEDIA",
      namaToko: "Toko A",
      namaBarang: "Paket",
      sku: "BDL-1",
      qty: 1,
      hargaJual: 100000,
      itemCodeBundle: "ITEM-1",
      qtyBundle: 2,
      lokasiGudang: "Lintas Jkt",
      status: "SHIPPED",
      totalPenjualanPerProduk: 80000,
      diskon: 20000,
      diskonLainnya: 0,
      biayaLainnya: 0,
    };
    const result = rapikan([row], new Map());
    expect(result.lines).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
    expect(result.lines[0].missingWeight).toBe(true);
    expect(result.lines[0].bundleKey).toBe("BDL-1-ITEM-1");
    expect(result.lines[0].hargaJual).toBeNull();
    expect(result.lines[0].totalDiskon).toBeNull();
    expect(result.lines[0].qty).toBe(2);
    expect(result.lines[0].sku).toBe("ITEM-1");
    expect(result.missingKeys).toEqual(["BDL-1-ITEM-1"]);
  });

  it("drops Pending, Paid, and Canceled and uses the original order number when REF is empty", () => {
    const base: RawSalesRow = {
      tanggal: null,
      noPesanan: "JP/POS/1",
      ref: null,
      channel: "JUBELIO-POS",
      namaToko: "Kasir",
      namaBarang: "Barang",
      sku: "SKU-1",
      qty: 3,
      hargaJual: 15000,
      itemCodeBundle: null,
      qtyBundle: 0,
      lokasiGudang: "Lintas Sby",
      status: "COMPLETED",
      totalPenjualanPerProduk: 45000,
      diskon: 0,
      diskonLainnya: 0,
      biayaLainnya: 500,
    };
    const result = rapikan(
      [
        { ...base, status: "PENDING" },
        { ...base, status: "Paid" },
        { ...base, status: "CANCELED" },
        { ...base, status: "CANCELLED" },
        base,
        { ...base, channel: "Shopee", status: "SHIPPED", noPesanan: "X", ref: "REF-SHOPEE", qty: 2, hargaJual: 10000, totalPenjualanPerProduk: 18000, diskon: 1000, diskonLainnya: 250, biayaLainnya: 50 },
      ],
      new Map(),
    );
    expect(result.droppedCount).toBe(4);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].noPesanan).toBe("JP/POS/1");
    expect(result.lines[0].isBundle).toBe(false);
    expect(result.lines[0].bobot).toBe(1);
    expect(result.lines[0].qty).toBe(3);
    expect(result.lines[0].hargaJual).toBe(3 * 15000);
    expect(result.lines[0].totalDiskon).toBe(500);
    expect(result.lines[1].isShopee).toBe(true);
    expect(result.lines[1].noPesanan).toBe("REF-SHOPEE");
    expect(result.lines[1].hargaJual).toBe(18000 / 2);
    expect(result.lines[1].totalDiskon).toBe(250);
  });

  it("divides Shopee by the original package qty, including bundle rows", () => {
    const weights = new Map([["40100083-40100083-01", 0.25]]);
    const base: RawSalesRow = {
      tanggal: "2026-10-26T00:00:00.000Z",
      noPesanan: "SP-1",
      ref: "261026M7VRKFSD",
      channel: "SHOPEE",
      namaToko: "Shopee",
      namaBarang: "Nutrimax",
      sku: "NTMKCL001L",
      qty: 2,
      hargaJual: 225000,
      itemCodeBundle: null,
      qtyBundle: 0,
      lokasiGudang: "Lintas Sby",
      status: "SHIPPED",
      totalPenjualanPerProduk: 360000,
      diskon: 0,
      diskonLainnya: 0,
      biayaLainnya: 0,
    };
    const result = rapikan(
      [
        base,
        {
          ...base,
          ref: "261026M2YTJ1YU",
          sku: "40100083",
          itemCodeBundle: "40100083-01",
          qtyBundle: 4,
          hargaJual: 61900,
          totalPenjualanPerProduk: 116000,
        },
      ],
      weights,
    );
    expect(result.lines[0].isBundle).toBe(false);
    expect(result.lines[0].qty).toBe(2);
    expect(result.lines[0].hargaJual).toBe(180000);
    expect(result.lines[1].isBundle).toBe(true);
    expect(result.lines[1].qty).toBe(8);
    expect(result.lines[1].sourceQty).toBe(2);
    expect(result.lines[1].bobot).toBe(0.25);
    expect(result.lines[1].hargaJual).toBe(14500);
    expect(result.lines[1].totalDiskon).toBe(0);
  });
});
