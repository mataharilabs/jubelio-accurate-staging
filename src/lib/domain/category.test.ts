import { describe, expect, it } from "vitest";
import { canSync, classifyOrder, diffVersions } from "@/lib/domain/orders";
import type { OrderVersion } from "@/lib/db/types";

function version(patch: Partial<OrderVersion> = {}): OrderVersion {
  return {
    id: "v1",
    noPesanan: "A1",
    versionNo: 1,
    importId: null,
    source: "import_raw",
    createdAt: "2026-10-28T00:00:00.000Z",
    createdBy: "test",
    isCurrent: true,
    tanggal: "2026-10-28T10:00:00",
    day: "2026-10-28",
    channel: "Shopee",
    storeName: "Bee & Flower",
    customerName: "Ani",
    customerCode: "ANI",
    province: "Jawa Timur",
    city: "Kota Surabaya",
    kurir: "SPX",
    status: "SHIPPED",
    lokasiGudang: "Lintas Sby",
    totalNilaiPesanan: 100000,
    totalDiskon: 10000,
    qty: 2,
    revenue: 90000,
    lines: [
      {
        id: "l1",
        sku: "SKU1",
        productName: "Barang",
        qty: 2,
        unitPrice: 50000,
        subTotal: 100000,
        unitDiskon: 5000,
        revenuePerUnit: 45000,
        missingWeight: false,
        bundleKey: null,
        unitCogs: null,
        flags: [],
      },
    ],
    ...patch,
  };
}

describe("sync categories", () => {
  it("treats a never-synced order as Baru", () => {
    expect(classifyOrder(version(), null)).toBe("Baru");
    expect(canSync("Baru", null, null, "v1")).toBe(true);
  });

  it("marks data changes since the synced version as Berubah and requires confirmation", () => {
    const synced = version({ id: "s1" });
    const current = version({ id: "v2", versionNo: 2, totalNilaiPesanan: 120000, qty: 3, lines: [{ ...version().lines[0], qty: 3, subTotal: 150000 }] });
    expect(classifyOrder(current, synced)).toBe("Berubah");
    expect(canSync("Berubah", null, null, "v2")).toBe(false);
    expect(canSync("Berubah", "confirmed", "v2", "v2")).toBe(true);
    expect(canSync("Berubah", "ignored", "v2", "v2")).toBe(false);
  });

  it("keeps a status-only change off the sync queue unless it became RETURNED", () => {
    const synced = version({ id: "s1", status: "PROCESSING" });
    expect(classifyOrder(version({ id: "v2", status: "SHIPPED" }), synced)).toBe("Status saja");
    expect(canSync("Status saja", "confirmed", "v2", "v2")).toBe(false);
    expect(classifyOrder(version({ id: "v2", status: "RETURNED" }), synced)).toBe("Returned");
  });

  it("flags a synced order that was canceled as Batal", () => {
    const synced = version({ id: "s1" });
    expect(classifyOrder(version({ id: "v2", source: "cancel", status: "CANCELED", lines: [] }), synced)).toBe("Batal");
    expect(classifyOrder(version({ source: "cancel", status: "CANCELED" }), null)).toBeNull();
  });

  it("records sku add and remove in the field diff", () => {
    const before = version({ id: "a" });
    const after = version({
      id: "b",
      lines: [{ ...version().lines[0], id: "l2", sku: "SKU2" }],
    });
    const fields = diffVersions(before, after).map((change) => `${change.kind}:${change.field}`);
    expect(fields).toContain("removed:line.SKU1");
    expect(fields).toContain("added:line.SKU2");
  });
});
