import { describe, expect, it } from "vitest";
import type { OrderVersion } from "@/lib/db/types";
import {
  accurateIntent,
  booksClosed,
  buildReturnVersions,
  canSoftDeleteOrder,
  carryOrderMeta,
  currentMonthRange,
  hppInclusive,
  hppIsPending,
  inSyncQueue,
  isBundlePending,
  isLossSiblingOrder,
  isMappingPending,
  previousEqualWindow,
  salesPushEnabled,
  shouldRefreshContentUpdated,
  yesterdayWib,
} from "@/lib/domain/phase3";

function version(patch: Partial<OrderVersion> = {}): OrderVersion {
  return {
    id: "v1",
    noPesanan: "SO-1",
    versionNo: 1,
    importId: null,
    source: "import_raw",
    createdAt: "2026-11-01T09:00:00.000Z",
    createdBy: null,
    isCurrent: true,
    tanggal: "2026-11-01T02:00:00",
    day: "2026-11-01",
    channel: "Shopee",
    storeName: "Toko A",
    customerName: "Andi",
    customerCode: "AND",
    province: "Jawa Barat",
    city: "Kota Bandung",
    kurir: "JNE",
    status: "COMPLETED",
    lokasiGudang: null,
    totalNilaiPesanan: 10000,
    totalDiskon: 0,
    qty: 1,
    revenue: 10000,
    lines: [{
      id: "l1",
      sku: "SKU-1",
      productName: "Sabun",
      qty: 2,
      unitPrice: 5000,
      subTotal: 10000,
      unitDiskon: 0,
      revenuePerUnit: 5000,
      missingWeight: false,
      bundleKey: null,
      unitCogs: null,
      flags: [],
    }],
    ...patch,
  };
}

describe("phase 3 rules", () => {
  it("uses HPP including PPN and treats a missing cost as zero", () => {
    expect(hppInclusive(10000)).toBe(11100);
    expect(hppInclusive(null)).toBe(0);
    expect(hppIsPending(null)).toBe(true);
    expect(hppIsPending(0)).toBe(false);
  });

  it("defaults the dashboard to the current month and compares an equal window", () => {
    expect(currentMonthRange("2026-11-05")).toEqual({ from: "2026-11-01", to: "2026-11-05" });
    expect(previousEqualWindow("2026-11-01", "2026-11-05")).toEqual({ from: "2026-10-27", to: "2026-10-31" });
    expect(yesterdayWib(new Date("2026-11-05T02:00:00.000Z"))).toBe("2026-11-04");
  });

  it("refreshes Tgl Updated only for returns, cancels, and non-status changes", () => {
    expect(shouldRefreshContentUpdated([{ field: "header.status" }], "SHIPPED")).toBe(false);
    expect(shouldRefreshContentUpdated([{ field: "header.status" }], "RETURNED")).toBe(true);
    expect(shouldRefreshContentUpdated([{ field: "header.city" }], "COMPLETED")).toBe(true);
    const previous = version({ contentUpdatedAt: "2026-11-01T09:00:00.000Z" });
    const next = version({ id: "v2", versionNo: 2, status: "SHIPPED", createdAt: "2026-11-02T09:00:00.000Z" });
    carryOrderMeta(previous, next, [{ field: "header.status" }]);
    expect(next.contentUpdatedAt).toBe("2026-11-01T09:00:00.000Z");
    const returned = version({ id: "v3", status: "RETURNED", createdAt: "2026-11-03T09:00:00.000Z" });
    carryOrderMeta(previous, returned, [{ field: "header.status" }]);
    expect(returned.contentUpdatedAt).toBe("2026-11-03T09:00:00.000Z");
  });

  it("blocks soft delete after a successful Accurate sync", () => {
    expect(canSoftDeleteOrder({ synced: false }).ok).toBe(true);
    expect(canSoftDeleteOrder({ synced: true }).ok).toBe(false);
  });

  it("describes Accurate cancel and return without sending a normal invoice", () => {
    expect(booksClosed("2026-09-30", "2026-09-30")).toBe(true);
    expect(accurateIntent({ status: "CANCELED", everSynced: true, orderDay: "2026-11-02", ppnReportDate: "2026-09-30" }).label).toBe("Hapus penjualan");
    expect(accurateIntent({ status: "CANCELED", everSynced: true, orderDay: "2026-09-01", ppnReportDate: "2026-09-30" }).label).toBe("Tidak diproses otomatis");
    expect(accurateIntent({ status: "RETURNED", everSynced: true, orderDay: "2026-11-02", ppnReportDate: "2026-09-30" }).send).toBe(false);
    expect(accurateIntent({ status: "RETURNED", everSynced: false, orderDay: "2026-11-02", ppnReportDate: null }).label).toBe("Tidak dikirim");
    expect(accurateIntent({ status: "COMPLETED", everSynced: false, orderDay: "2026-11-02" }).label).toBe("Buat penjualan");
  });

  it("keeps the Accurate queue to rows newer than the last sync", () => {
    expect(inSyncQueue({ category: "Status saja" })).toBe(false);
    expect(inSyncQueue({ category: "Baru", dataStatus: "deleted" })).toBe(false);
    expect(inSyncQueue({ category: "Berubah", contentUpdatedAt: "2026-11-02", syncedAt: "2026-11-03" })).toBe(false);
    expect(inSyncQueue({ category: "Returned", contentUpdatedAt: "2026-11-04", syncedAt: "2026-11-03" })).toBe(true);
    expect(inSyncQueue({ category: "Baru", ignored: true })).toBe(false);
  });

  it("marks an unmapped row and a new bundle as pending", () => {
    expect(isMappingPending({ mappedAt: null, channel: "Shopee", store: "Toko" })).toBe(true);
    expect(isMappingPending({ mappedAt: "2026-11-01", channel: "Shopee", store: "Toko" })).toBe(false);
    expect(isMappingPending({ needsReview: false, channel: "Shopee", store: "Toko" })).toBe(false);
    expect(isBundlePending({ confirmedAt: null })).toBe(true);
    expect(isBundlePending({})).toBe(false);
  });

  it("keeps return prices and builds a zero-price Internal sibling for case 2 and 3", () => {
    const original = version();
    const partial = buildReturnVersions(original, null, {
      status: "RETURNED",
      returnCase: 2,
      lost: [{ sku: "SKU-1", qty: 1 }],
      by: "admin",
      now: "2026-11-04T10:00:00.000Z",
    });
    expect(partial.error).toBeUndefined();
    expect(partial.versions[0].lines[0].unitPrice).toBe(5000);
    expect(partial.versions[0].returnCase).toBe(2);
    expect(partial.versions[1].noPesanan).toBe("SO-1-R");
    expect(partial.versions[1].channel).toBe("Internal");
    expect(partial.versions[1].storeName).toBe("Barang Hilang");
    expect(partial.versions[1].lines[0].unitPrice).toBe(0);
    expect(partial.versions[1].lossSibling).toBe(true);
    expect(isLossSiblingOrder(partial.versions[1])).toBe(true);
    const refused = buildReturnVersions(original, null, { status: "RETURNED", returnCase: null, lost: [], by: null, now: "2026-11-04T10:00:00.000Z" });
    expect(refused.error).toMatch(/Case/);
  });

  it("sends Accurate sales only when the guard is exactly enabled", () => {
    expect(salesPushEnabled(undefined)).toBe(false);
    expect(salesPushEnabled("true")).toBe(false);
    expect(salesPushEnabled("enabled")).toBe(true);
  });
});
