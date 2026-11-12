import { describe, expect, it } from "vitest";
import type { OrderLine, OrderVersion } from "@/lib/db/types";
import { reportOf, salesProductName } from "@/lib/domain/aggregate";

function line(patch: Partial<OrderLine>): OrderLine {
  return {
    id: "l1",
    sku: "NTMVTD8001L",
    productName: "Nutrimax Vitamin D3+K2 800 IU Softgel listing panjang",
    qty: 1,
    unitPrice: 100,
    subTotal: 100,
    unitDiskon: 0,
    revenuePerUnit: 100,
    missingWeight: false,
    bundleKey: null,
    unitCogs: 10,
    flags: [],
    ...patch,
  };
}

function version(lines: OrderLine[], no = "SO-1"): OrderVersion {
  return {
    id: no,
    noPesanan: no,
    versionNo: 1,
    importId: null,
    source: "import_raw",
    createdAt: "2026-11-01T00:00:00.000Z",
    createdBy: null,
    isCurrent: true,
    tanggal: "2026-11-01T02:00:00",
    day: "2026-11-01",
    channel: "Shopee",
    storeName: "Toko",
    customerName: "Ani",
    customerCode: "ANI",
    province: "Jawa Barat",
    city: "Bandung",
    kurir: "",
    status: "SHIPPED",
    lokasiGudang: null,
    totalNilaiPesanan: 100,
    totalDiskon: 0,
    qty: 1,
    revenue: 100,
    lines,
  };
}

const query = {
  from: null,
  to: null,
  granularity: "day" as const,
  channels: [],
  stores: [],
  provinces: [],
  cities: [],
  statuses: [],
  couriers: [],
  skus: [],
};

describe("dashboard product names", () => {
  it("prefers the master name over the marketplace listing title", () => {
    expect(salesProductName("Nutrimax Vitamin D3+K2", "listing panjang")).toBe("Nutrimax Vitamin D3+K2");
    expect(salesProductName("", "listing panjang")).toBe("listing panjang");
    const report = reportOf(
      [version([line({})])],
      query,
      new Map([["NTMVTD8001L", "Nutrimax Vitamin D3+K2"]]),
    );
    expect(report.products[0]).toMatchObject({ sku: "NTMVTD8001L", name: "Nutrimax Vitamin D3+K2" });
  });

  it("falls back to the lexicographic max line title when the master name is blank", () => {
    const report = reportOf(
      [
        version([line({ productName: "Alpha listing" })], "SO-1"),
        version([line({ id: "l2", productName: "Zebra listing" })], "SO-2"),
      ],
      query,
      new Map([["NTMVTD8001L", ""]]),
    );
    expect(report.products[0].name).toBe("Zebra listing");
  });
});
