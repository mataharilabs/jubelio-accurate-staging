import { describe, expect, it } from "vitest";
import { orderToRawRows, wibDay, wibWindowUtc, type ApiOrder, type BundleRecord } from "@/lib/jubelio/adapter";

const order: ApiOrder = {
  salesorder_id: 99,
  salesorder_no: "SP-1",
  transaction_date: "2026-10-27T17:30:00.000Z",
  ref_no: "REF-1",
  source_name: "WEBSTORE",
  store_name: "",
  shipping_full_name: "Sari",
  customer_name: "Akun",
  shipping_city: "SURABAYA",
  shipping_province: "JAWA TIMUR",
  courier: "SPX",
  internal_status: "SHIPPED",
  total_disc: 1000,
  add_disc: 250,
  service_fee: 10,
  add_fee: 40,
  location_name: "Gudang lain",
  items: [
    {
      item_id: 7,
      is_bundle: true,
      item_code: "BDL",
      description: "Paket",
      qty_in_base: 2,
      price: 50000,
      amount: 80000,
      loc_name: "Lintas Sby",
    },
    {
      item_id: 8,
      is_bundle: false,
      item_code: "SINGLE",
      description: "Nutrimax",
      qty: 3,
      price: 10000,
      amount: 30000,
      loc_name: "East Java & Co",
    },
  ],
};

describe("jubelio adapter", () => {
  it("maps the approved fields, expands bundles by item_id, and keeps only configured locations", () => {
    const bundles = new Map<number, BundleRecord>([
      [7, { item_id: 7, bundles: [{ item_code: "40100083-01", item_name: "Bee & Flower Cendana", qty: 4 }] }],
    ]);
    const { rows, missingBundles } = orderToRawRows(order, bundles, { locations: ["Lintas Sby"] });
    expect(missingBundles).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(wibDay(order.transaction_date)).toBe("2026-10-28");
    expect(rows[0]).toMatchObject({
      noPesanan: "SP-1",
      ref: "REF-1",
      channel: "WEBSTORE",
      namaToko: "",
      pelanggan: "Sari",
      kota: "SURABAYA",
      provinsi: "JAWA TIMUR",
      namaBarang: "Paket",
      sku: "BDL",
      qty: 2,
      hargaJual: 50000,
      itemCodeBundle: "40100083-01",
      itemNameBundle: "Bee & Flower Cendana",
      qtyBundle: 4,
      kurir: "SPX",
      lokasiGudang: "Lintas Sby",
      status: "SHIPPED",
      totalPenjualanPerProduk: 80000,
      diskon: 1000,
      diskonLainnya: 250,
      biayaLainnya: 40,
    });
    expect(rows[0].tanggal?.toISOString().slice(0, 19)).toBe("2026-10-28T00:30:00");
  });

  it("uses the WIB calendar window the list endpoint expects", () => {
    expect(wibWindowUtc("2026-10-28")).toEqual({
      from: "2026-10-27T17:00:00.000Z",
      to: "2026-10-28T16:59:59.999Z",
    });
  });
});
