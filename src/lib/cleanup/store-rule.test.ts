import { describe, expect, it } from "vitest";
import { channelStoreKey, rapikan, type RapikanMaps, type RawSalesRow } from "@/lib/cleanup/rapikan";

function row(patch: Partial<RawSalesRow>): RawSalesRow {
  return {
    tanggal: new Date("2026-10-28T10:00:00Z"),
    noPesanan: "ORD-1",
    ref: "ORD-1",
    channel: "Offline market",
    namaToko: "",
    pelanggan: "Ani",
    kota: "",
    provinsi: "",
    namaBarang: "Bee & Flower Cendana 125 gr",
    sku: "40100083",
    qty: 1,
    hargaJual: 20000,
    itemCodeBundle: null,
    itemNameBundle: null,
    qtyBundle: 0,
    kurir: "",
    lokasiGudang: null,
    status: "SHIPPED",
    totalPenjualanPerProduk: 20000,
    diskon: 0,
    diskonLainnya: 0,
    biayaLainnya: 0,
    ...patch,
  };
}

function maps(): RapikanMaps {
  const channels = new Map<string, { channel: string; store: string }>([
    [channelStoreKey("Whatsapp", ""), { channel: "Whatsapp", store: "Jansen Official Store" }],
    [channelStoreKey("Offline market", ""), { channel: "Offline Market", store: "Jansen Official Store" }],
    [channelStoreKey("WEBSTORE", ""), { channel: "Website", store: "Jansen Official Store" }],
    [channelStoreKey("JUBELIO-POS", "", true), { channel: "Jubelio POS", store: "Jansen Official Store" }],
  ]);
  return { weights: new Map(), channels, provinces: new Map(), cities: new Map() };
}

describe("blank store brand rule", () => {
  it("assigns Bee & Flower when every item in a blank-store offline order is that brand", () => {
    const result = rapikan([
      row({ namaBarang: "Bee & Flower Cendana 125 gr" }),
      row({ sku: "FL-1", namaBarang: "Flauhra By Bee Flower White Sandalwood 125 gr" }),
    ], maps());
    expect(result.lines.map((line) => [line.channel, line.storeName])).toEqual([
      ["Offline Market", "Bee & Flower"],
      ["Offline Market", "Bee & Flower"],
    ]);
  });

  it("keeps Jansen Official Store when the blank-store order is mixed or another brand", () => {
    const mixed = rapikan([
      row({ namaBarang: "Bee & Flower Cendana 125 gr" }),
      row({ sku: "NTM-1", namaBarang: "Nutrimax Vitamin D3 1000 IU" }),
    ], maps());
    expect(mixed.lines.every((line) => line.storeName === "Jansen Official Store" && line.channel === "Offline Market")).toBe(true);

    const other = rapikan([row({ namaBarang: "Nutrimax Vitamin D3 1000 IU" })], maps());
    expect(other.lines[0]?.storeName).toBe("Jansen Official Store");
  });

  it("maps a WEBSTORE Bee & Flower order to Website / Bee & Flower", () => {
    const result = rapikan([
      row({
        channel: "WEBSTORE",
        namaBarang: "component",
        itemCodeBundle: "40100083-01",
        itemNameBundle: "bee flower cendana",
        qtyBundle: 1,
      }),
    ], maps());
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.channel).toBe("Website");
    expect(result.lines[0]?.storeName).toBe("Bee & Flower");
  });

  it("does not rewrite Jubelio POS, which already maps to Jansen Official Store", () => {
    const result = rapikan([
      row({ channel: "JUBELIO-POS", namaToko: "", lokasiGudang: "Lintas Sby", namaBarang: "Bee & Flower Cendana 125 gr" }),
    ], maps());
    expect(result.lines[0]?.channel).toBe("Jubelio POS");
    expect(result.lines[0]?.storeName).toBe("Jansen Official Store");
  });
});
