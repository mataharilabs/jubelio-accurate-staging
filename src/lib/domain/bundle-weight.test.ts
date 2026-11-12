import { describe, expect, it } from "vitest";
import { rapikan, type RapikanMaps, type RawSalesRow } from "@/lib/cleanup/rapikan";
import {
  allocateBundleAmounts,
  bundlesFromLegacyWeights,
  componentExtendedCost,
  parentFromBundleKey,
  splitLegacyBundleKey,
  splitWeights,
  weightTotalError,
} from "@/lib/domain/bundle-weight";

describe("bundle percentage allocation", () => {
  it("gives the rounding remainder to the last component so the parts sum to the line amount", () => {
    const rows = allocateBundleAmounts(100, [
      { sku: "A", qty: 1, weightPct: 33.3333 },
      { sku: "B", qty: 1, weightPct: 33.3333 },
      { sku: "C", qty: 1, weightPct: 33.3334 },
    ]);
    expect(rows.map((row) => row.amount)).toEqual([33.33, 33.33, 33.34]);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(100);
    expect(rows.map((row) => row.qty)).toEqual([1, 1, 1]);
  });

  it("keeps component quantity and extended HPP as unit cost times qty", () => {
    const rows = allocateBundleAmounts(100000, [
      { sku: "A", qty: 2, weightPct: 25 },
      { sku: "B", qty: 6, weightPct: 75 },
    ]);
    expect(rows.map((row) => row.qty)).toEqual([2, 6]);
    expect(rows.map((row) => row.amount)).toEqual([25000, 75000]);
    expect(componentExtendedCost(1000, rows[0].qty)).toBe(2000);
    expect(componentExtendedCost(500, rows[1].qty)).toBe(3000);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(100000);
  });

  it("splits an even total by qty and an even total equally, both ending at 100", () => {
    expect(splitWeights([{ qty: 1 }, { qty: 1 }, { qty: 2 }], "qty")).toEqual([25, 25, 50]);
    const even = splitWeights([{ qty: 1 }, { qty: 1 }, { qty: 1 }], "equal");
    expect(even.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(even[2]).toBeCloseTo(33.3334, 4);
    expect(weightTotalError([
      { sku: "A", qty: 1, weightPct: 40 },
      { sku: "B", qty: 1, weightPct: 50 },
    ])).toMatch(/100%/);
    expect(weightTotalError([
      { sku: "A", qty: 1, weightPct: 40 },
      { sku: "B", qty: 1, weightPct: 60 },
    ])).toBeNull();
  });

  it("allocates bundle revenue and discount by percentage through rapikan", () => {
    const maps: RapikanMaps = {
      weights: new Map([["PAKET-A", 0.9], ["PAKET-B", 0.1]]),
      componentWeights: new Map([
        ["PAKET", [
          { sku: "A", qty: 1, weightPct: 30 },
          { sku: "B", qty: 3, weightPct: 70 },
        ]],
      ]),
      channels: new Map(),
      provinces: new Map(),
      cities: new Map(),
    };
    const base: RawSalesRow = {
      tanggal: new Date("2026-11-01T03:00:00Z"),
      noPesanan: "ORD-1",
      ref: "ORD-1",
      channel: "WEBSTORE",
      namaToko: "Toko",
      pelanggan: "Ani",
      kota: "Bandung",
      provinsi: "Jawa Barat",
      namaBarang: "Paket listing",
      sku: "PAKET",
      qty: 2,
      hargaJual: 10000,
      itemCodeBundle: "A",
      itemNameBundle: "Komponen A",
      qtyBundle: 1,
      kurir: "",
      lokasiGudang: null,
      status: "SHIPPED",
      totalPenjualanPerProduk: 20000,
      diskon: 1000,
      diskonLainnya: 0,
      biayaLainnya: 0,
    };
    const result = rapikan([
      base,
      { ...base, itemCodeBundle: "B", itemNameBundle: "Komponen B", qtyBundle: 3 },
    ], maps);
    const bySku = new Map(result.lines.map((line) => [line.sku, line]));
    expect(bySku.get("A")).toMatchObject({ qty: 2, subTotal: 6000, missingWeight: false });
    expect(bySku.get("B")).toMatchObject({ qty: 6, subTotal: 14000, missingWeight: false });
    expect(result.lines.reduce((sum, line) => sum + (line.subTotal ?? 0), 0)).toBe(20000);
    const discount = result.lines.reduce((sum, line) => sum + (line.unitDiskon ?? 0) * line.qty, 0);
    expect(discount).toBeCloseTo(1000, 6);
    expect((bySku.get("A")!.unitDiskon ?? 0) * 2).toBeCloseTo(300, 6);
    expect((bySku.get("B")!.unitDiskon ?? 0) * 6).toBeCloseTo(700, 6);
    expect(result.missingKeys).toEqual([]);
  });

  it("splits a legacy key on the longest known component SKU", () => {
    expect(splitLegacyBundleKey("BEECN-650-4X125-40100083-01", ["01", "40100083-01"])).toEqual({
      bundleSku: "BEECN-650-4X125",
      componentSku: "40100083-01",
    });
    expect(parentFromBundleKey("PAKET-A", "A")).toBe("PAKET");
    const bundles = bundlesFromLegacyWeights(
      [{ bundleKey: "PAKET-A" }, { bundleKey: "PAKET-B" }, { bundleKey: "SENDIRI" }],
      ["A", "B"],
    );
    expect(bundles).toEqual([
      {
        bundleSku: "PAKET",
        components: [
          { sku: "A", qty: 1, weightPct: 50 },
          { sku: "B", qty: 1, weightPct: 50 },
        ],
      },
      { bundleSku: "SENDIRI", components: [{ sku: "SENDIRI", qty: 1, weightPct: 100 }] },
    ]);
  });
});
