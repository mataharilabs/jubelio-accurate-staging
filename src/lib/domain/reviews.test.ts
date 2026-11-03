import { describe, expect, it } from "vitest";
import type { CleanLine } from "@/lib/cleanup/rapikan";
import { planImport } from "@/lib/domain/plan";
import { reviewsFromLines } from "@/lib/domain/orders";

function line(patch: Partial<CleanLine> = {}): CleanLine {
  return {
    tanggal: "2026-10-28T10:00:00",
    day: "2026-10-28",
    noPesanan: "ORD-1",
    channel: "Shopee",
    storeName: "Toko A",
    sku: "SKU-1",
    productName: "Barang",
    qty: 1,
    unitPrice: 1000,
    subTotal: 1000,
    totalNilaiPesanan: 1000,
    totalDiskon: 0,
    unitDiskon: 0,
    revenuePerUnit: 1000,
    customerName: "Ani",
    customerCode: "ANI",
    province: "Jawa Barat",
    city: "Kota Bogor",
    kurir: "SPX",
    status: "SHIPPED",
    lokasiGudang: null,
    missingWeight: false,
    bundleKey: null,
    flags: [],
    ...patch,
  };
}

describe("review items created on import", () => {
  it("keys channel/store and city with a space-pipe separator and bobot by bundle key", () => {
    const items = reviewsFromLines([
      line({ flags: ["channel"], channel: "Whatsapp", storeName: "" }),
      line({ noPesanan: "ORD-2", flags: ["channel"], channel: "Offline market", storeName: "" }),
      line({ noPesanan: "ORD-3", flags: ["channel"], channel: "WEBSTORE", storeName: "" }),
      line({ noPesanan: "ORD-4", flags: ["channel"], channel: "Shopee", storeName: "Bee & Flower" }),
      line({ noPesanan: "ORD-5", flags: ["kota"], province: "JAWA TIMUR", city: "KAB. LAMONGAN" }),
      line({
        noPesanan: "ORD-6",
        flags: [],
        missingWeight: true,
        bundleKey: "HTCCA001L-07-HTCCA001L-01",
        sku: "HTCCA001L-01",
      }),
    ]);

    const byKind = (kind: string) => items.filter((item) => item.kind === kind);
    expect(byKind("channel_store").map((item) => item.rawKey)).toEqual([
      "Whatsapp | ",
      "Offline market | ",
      "WEBSTORE | ",
      "Shopee | Bee & Flower",
    ]);
    expect(byKind("channel_store")[0].detail).toEqual({ channel: "Whatsapp", store: "" });
    expect(byKind("city")).toEqual([
      { kind: "city", rawKey: "JAWA TIMUR | KAB. LAMONGAN", detail: { province: "JAWA TIMUR", city: "KAB. LAMONGAN" } },
    ]);
    expect(byKind("bobot")).toEqual([
      {
        kind: "bobot",
        rawKey: "HTCCA001L-07-HTCCA001L-01",
        detail: { bundleKey: "HTCCA001L-07-HTCCA001L-01", sku: "HTCCA001L-01" },
      },
    ]);
    expect(items.every((item) => !item.rawKey.includes("\u0000"))).toBe(true);
  });

  it("strips NUL from review keys and detail so Postgres can store them", () => {
    const items = reviewsFromLines([
      line({ flags: ["channel", "kota"], channel: "What\u0000sapp", storeName: "To\u0000ko", province: "Ja\u0000wa", city: "Bog\u0000or" }),
      line({ noPesanan: "ORD-2", missingWeight: true, bundleKey: "BDL\u0000-1", sku: "SKU\u0000-1" }),
    ]);
    expect(items.map((item) => item.rawKey)).toEqual([
      "Whatsapp | Toko",
      "Jawa | Bogor",
      "BDL-1",
    ]);
    expect(JSON.stringify(items)).not.toContain("\\u0000");
    expect(items[0].detail).toEqual({ channel: "Whatsapp", store: "Toko" });
  });

  it("attaches those review rows to the import plan", () => {
    const plan = planImport(new Map(), [
      line({ flags: ["channel"], channel: "WEBSTORE", storeName: "" }),
      line({ flags: ["kota"], province: "BANTEN", city: "KOTA TANGERANG" }),
      line({ missingWeight: true, bundleKey: "HTCCA001L-07-HTCCA001L-01", sku: "HTCCA001L-01" }),
    ], {
      importId: "imp",
      source: "import_clean",
      createdAt: "2026-10-31T00:00:00.000Z",
      createdBy: "test",
    });
    expect(plan.reviews.map((item) => `${item.kind}:${item.rawKey}`)).toEqual([
      "channel_store:WEBSTORE | ",
      "city:BANTEN | KOTA TANGERANG",
      "bobot:HTCCA001L-07-HTCCA001L-01",
    ]);
  });

  it("keys a city review on the raw province Jubelio sent, not the mapped name", () => {
    const items = reviewsFromLines([
      line({ flags: ["kota"], province: "Aceh", provinceRaw: "NANGGROE ACEH DARUSSALAM", city: "JANTHO" }),
    ]);
    expect(items[0].rawKey).toBe("NANGGROE ACEH DARUSSALAM | JANTHO");
    expect(items[0].detail).toEqual({ province: "NANGGROE ACEH DARUSSALAM", city: "JANTHO", provinceOfficial: "Aceh" });
  });
});
