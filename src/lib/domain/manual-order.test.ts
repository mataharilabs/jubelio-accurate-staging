import { describe, expect, it } from "vitest";
import type { CleanLine } from "@/lib/cleanup/rapikan";
import { buildManualOrder } from "@/lib/domain/manual-order";
import { planImport } from "@/lib/domain/plan";
import { AppError } from "@/lib/errors";

const products = new Map([["SKU-1", "Madu"], ["SKU-2", "Teh"]]);

describe("manual order", () => {
  it("prices revenue the same way as a Jubelio line and leaves HPP to the SKU lookup", () => {
    const version = buildManualOrder({
      noPesanan: " MANUAL-1 ",
      tanggal: "2026-11-04T16:01",
      channel: "Shopee",
      storeName: "Bee & Flower",
      customerName: "Rina",
      status: "SHIPPED",
      province: "Jawa Timur",
      city: "Kota Surabaya",
      kurir: "JNE",
      lines: [
        { sku: "SKU-1", qty: 2, unitPrice: 10000, unitDiskon: 1000 },
        { sku: "SKU-2", qty: 1, unitPrice: 5000, unitDiskon: 0 },
      ],
    }, products, { createdAt: "2026-11-04T09:01:00.000Z", createdBy: "rina@contoh.co.id" });

    expect(version.source).toBe("manual");
    expect(version.noPesanan).toBe("MANUAL-1");
    expect(version.day).toBe("2026-11-04");
    expect(version.createdBy).toBe("rina@contoh.co.id");
    expect(version.contentUpdatedAt).toBe("2026-11-04T09:01:00.000Z");
    expect(version.dataStatus).toBe("active");
    expect(version.lines[0]).toMatchObject({
      sku: "SKU-1",
      productName: "Madu",
      qty: 2,
      unitPrice: 10000,
      unitDiskon: 1000,
      revenuePerUnit: 9000,
      subTotal: 20000,
      unitCogs: null,
    });
    expect(version.revenue).toBe(23000);
    expect(version.totalDiskon).toBe(2000);
    expect(version.totalNilaiPesanan).toBe(25000);
    expect(version.qty).toBe(3);
  });

  it("rejects an unknown SKU, a duplicate number is left to the store, and a bad line", () => {
    expect(() => buildManualOrder({
      noPesanan: "M-2",
      tanggal: "2026-11-01",
      channel: "",
      storeName: "",
      customerName: "",
      status: "COMPLETED",
      province: "",
      city: "",
      kurir: "",
      lines: [{ sku: "TIDAK-ADA", qty: 1, unitPrice: 1, unitDiskon: 0 }],
    }, products, { createdAt: "2026-11-01T00:00:00.000Z", createdBy: null })).toThrow(AppError);

    expect(() => buildManualOrder({
      noPesanan: "M-3",
      tanggal: "bukan-tanggal",
      channel: "",
      storeName: "",
      customerName: "",
      status: "COMPLETED",
      province: "",
      city: "",
      kurir: "",
      lines: [{ sku: "SKU-1", qty: 1, unitPrice: 1, unitDiskon: 0 }],
    }, products, { createdAt: "2026-11-01T00:00:00.000Z", createdBy: null })).toThrow(/Tanggal/);
  });
});

function line(patch: Partial<CleanLine> = {}): CleanLine {
  return {
    tanggal: "2026-11-04T10:00:00",
    day: "2026-11-04",
    noPesanan: "MANUAL-1",
    channel: "Shopee",
    storeName: "Toko B",
    sku: "SKU-1",
    productName: "Nama Jubelio",
    qty: 9,
    unitPrice: 1,
    subTotal: 9,
    totalNilaiPesanan: 9,
    totalDiskon: 0,
    unitDiskon: 0,
    revenuePerUnit: 1,
    customerName: "Jubelio",
    customerCode: "JUB",
    province: "Jawa Barat",
    city: "Kota Bogor",
    kurir: "SPX",
    status: "COMPLETED",
    lokasiGudang: null,
    missingWeight: false,
    bundleKey: null,
    flags: [],
    ...patch,
  };
}

describe("Jubelio sync leaves a manual order alone", () => {
  const manual = buildManualOrder({
    noPesanan: "MANUAL-1",
    tanggal: "2026-11-04T08:00",
    channel: "Shopee",
    storeName: "Toko A",
    customerName: "Rina",
    status: "SHIPPED",
    province: "Jawa Timur",
    city: "Kota Surabaya",
    kurir: "",
    lines: [{ sku: "SKU-1", qty: 1, unitPrice: 10000, unitDiskon: 0 }],
  }, products, { createdAt: "2026-11-04T01:00:00.000Z", createdBy: "rina@contoh.co.id" });

  it("does not replace the manual order when the Jubelio import is protected", () => {
    const plan = planImport(new Map([[manual.noPesanan, manual]]), [line()], {
      importId: "imp",
      source: "import_raw",
      createdAt: "2026-11-05T00:00:00.000Z",
      createdBy: "cron",
      duplicate: "overwrite",
      protectManual: true,
    });
    expect(plan.versions).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
    expect(plan.retireIds).toHaveLength(0);
  });

  it("still follows Timpa and Lewati for a file import", () => {
    const overwrite = planImport(new Map([[manual.noPesanan, manual]]), [line()], {
      importId: "imp",
      source: "import_raw",
      createdAt: "2026-11-05T00:00:00.000Z",
      createdBy: "rina@contoh.co.id",
      duplicate: "overwrite",
    });
    expect(overwrite.versions).toHaveLength(1);
    expect(overwrite.versions[0].source).toBe("import_raw");
    expect(overwrite.versions[0].qty).toBe(9);

    const skip = planImport(new Map([[manual.noPesanan, manual]]), [line()], {
      importId: "imp",
      source: "import_raw",
      createdAt: "2026-11-05T00:00:00.000Z",
      createdBy: "rina@contoh.co.id",
      duplicate: "skip",
    });
    expect(skip.versions).toHaveLength(0);
    expect(skip.unchanged).toBe(1);
  });
});
