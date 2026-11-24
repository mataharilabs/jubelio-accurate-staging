import { describe, expect, it } from "vitest";
import type { OrderLine, OrderVersion } from "@/lib/db/types";
import { classifyOrder } from "@/lib/domain/orders";
import { reviewRow } from "@/lib/domain/review-rows";
import {
  accurateIntent,
  needsAccurateSync,
  SYNC_FAILED_REASON,
  syncFailureForVersion,
  syncReason,
} from "@/lib/domain/phase3";
import {
  displayedQueue,
  pageSyncReview,
  sqlAccurateAction,
  sqlClassify,
  sqlDisplayedQueue,
  sqlQueueMember,
  sqlSyncFailure,
  sqlSyncReason,
  type QueueSnapshot,
} from "@/lib/domain/sync-queue";

function line(patch: Partial<OrderLine> = {}): OrderLine {
  return {
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
    ...patch,
  };
}

function version(patch: Partial<OrderVersion> = {}): OrderVersion {
  return {
    id: "v1",
    noPesanan: "SO-1",
    versionNo: 1,
    importId: null,
    source: "import_raw",
    createdAt: "2026-11-16T00:00:00.000Z",
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
    qty: 2,
    revenue: 10000,
    lines: [line()],
    dataStatus: "active",
    contentUpdatedAt: "2026-11-16T00:00:00.000Z",
    ...patch,
  };
}

function snapshot(patch: Partial<QueueSnapshot> & { current?: OrderVersion } = {}): QueueSnapshot {
  return {
    current: patch.current ?? version(),
    synced: patch.synced ?? null,
    syncedAt: patch.syncedAt ?? null,
    accurateNumber: patch.accurateNumber ?? null,
    batchItems: patch.batchItems ?? [],
    orderSyncs: patch.orderSyncs ?? [],
    ppnReportDate: patch.ppnReportDate ?? null,
  };
}

describe("sync queue parity", () => {
  it("uses the same queue membership as needsAccurateSync", () => {
    const cases = [
      { dataStatus: "deleted", contentUpdatedAt: "2026-11-04", syncedAt: null },
      { dataStatus: "active", contentUpdatedAt: "2026-11-01", syncedAt: null },
      { dataStatus: "active", contentUpdatedAt: null, syncedAt: null },
      { dataStatus: "active", contentUpdatedAt: "2026-11-04", syncedAt: "2026-11-03" },
      { dataStatus: "active", contentUpdatedAt: "2026-11-02", syncedAt: "2026-11-03" },
      { dataStatus: "active", contentUpdatedAt: "2026-11-03", syncedAt: "2026-11-03" },
      { dataStatus: "active", contentUpdatedAt: null, syncedAt: "2026-11-03" },
      { dataStatus: "active", contentUpdatedAt: "", syncedAt: "" },
      { dataStatus: undefined, contentUpdatedAt: "2026-11-04", syncedAt: undefined },
    ];
    for (const input of cases) {
      expect(sqlQueueMember(input)).toBe(needsAccurateSync(input));
    }
  });

  it("keeps Gagal sync and the other reasons aligned with syncFailureForVersion", () => {
    const versionId = "v-now";
    const created = "2026-11-16T00:00:00.000Z";
    const cases = [
      {
        batchItems: [{ versionId, at: "2026-11-16T01:00:00.000Z", status: "gagal", error: "Pelanggan tidak ada" }],
        orderSyncs: [{ at: "2026-11-15T01:00:00.000Z", status: "gagal", error: "lama" }],
      },
      {
        batchItems: [
          { versionId, at: "2026-11-16T01:00:00.000Z", status: "gagal", error: "gagal dulu" },
          { versionId, at: "2026-11-16T02:00:00.000Z", status: "berhasil", error: null },
        ],
        orderSyncs: [],
      },
      {
        batchItems: [{ versionId: "v-old", at: "2026-11-16T03:00:00.000Z", status: "gagal", error: "versi lama" }],
        orderSyncs: [{ at: "2026-11-16T04:00:00.000Z", status: "gagal", error: "Nomor sudah dipakai" }],
      },
      {
        batchItems: [{ versionId, at: "2026-11-16T01:00:00.000Z", status: "gagal", error: "gagal" }],
        orderSyncs: [{ at: "2026-11-16T05:00:00.000Z", status: "tersinkron", error: null }],
      },
      {
        batchItems: [{ versionId, at: "2026-11-16T01:00:00.000Z", status: "gagal", error: "   " }],
        orderSyncs: [],
      },
      {
        batchItems: [{ versionId, at: "2026-11-16T01:00:00.000Z", status: "pratinjau", error: "abaikan" }],
        orderSyncs: [],
      },
    ];
    for (const input of cases) {
      const original = syncFailureForVersion({ versionId, versionCreatedAt: created, ...input });
      const sql = sqlSyncFailure({ versionId, versionCreatedAt: created, ...input });
      expect(sql).toBe(original);
      expect(sqlSyncReason("Baru", false, Boolean(sql))).toBe(syncReason("Baru", false, Boolean(original)));
    }
    expect(sqlSyncReason("Baru", false, true)).toBe(SYNC_FAILED_REASON);
    expect(sqlSyncReason("Berubah", true, false)).toBe("Data berubah");
    expect(sqlSyncReason("Returned", true, false)).toBe(syncReason("Returned", true, false));
    expect(sqlSyncReason("Batal", true, false)).toBe(syncReason("Batal", true, false));
    expect(sqlSyncReason("Status saja", true, false)).toBe(syncReason("Status saja", true, false));
  });

  it("classifies orders the same way, including line edits inside and outside the money epsilon", () => {
    const current = version();
    const synced = version({ id: "v0", isCurrent: false, lines: [line()] });
    const pairs: [OrderVersion | null, OrderVersion | null][] = [
      [null, null],
      [current, null],
      [version({ source: "manual_delete" }), null],
      [version({ source: "manual_delete" }), synced],
      [version({ source: "cancel", status: "CANCELED" }), null],
      [version({ status: "CANCELED" }), synced],
      [current, synced],
      [version({ lines: [line({ qty: 3 })], qty: 3 }), synced],
      [version({ lines: [line({ unitPrice: 5000.4 })] }), synced],
      [version({ lines: [line({ unitPrice: 5000.6 })] }), synced],
      [version({ lines: [line({ sku: "SKU-2" })] }), synced],
      [version({ lines: [] }), synced],
      [version({ status: "SHIPPED" }), synced],
      [version({ status: "RETURNED" }), synced],
      [version({ status: "RETURNED", lines: [line({ qty: 1 })] }), synced],
    ];
    for (const [next, previous] of pairs) {
      expect(sqlClassify(next, previous)).toBe(classifyOrder(next, previous));
    }
  });

  it("uses the same Accurate action labels, including tutup buku", () => {
    const cases = [
      { status: "CANCELED", everSynced: true, orderDay: "2026-11-02", ppnReportDate: "2026-09-30" },
      { status: "CANCELED", everSynced: true, orderDay: "2026-09-01", ppnReportDate: "2026-09-30" },
      { status: "RETURNED", everSynced: true, orderDay: "2026-11-02", ppnReportDate: "2026-09-30" },
      { status: "RETURNED", everSynced: true, orderDay: "2026-09-01", ppnReportDate: "2026-09-30" },
      { status: "RETURNED", everSynced: false, orderDay: "2026-11-02", ppnReportDate: null },
      { status: "CANCELED", everSynced: false, orderDay: "2026-11-02", ppnReportDate: null },
      { status: "COMPLETED", everSynced: false, orderDay: "2026-11-02", lossSibling: true },
      { status: "COMPLETED", everSynced: false, orderDay: "2026-11-02" },
      { status: "COMPLETED", everSynced: true, orderDay: "2026-11-02", ppnReportDate: "2026-09-30" },
    ];
    for (const input of cases) {
      expect(sqlAccurateAction(input)).toBe(accurateIntent(input).label);
    }
  });

  it("shows the same queue rows, Gagal sync text, and reasons as the current page", () => {
    const synced = version({ id: "v0", isCurrent: false, contentUpdatedAt: "2026-11-01T00:00:00.000Z" });
    const rows: QueueSnapshot[] = [
      snapshot(),
      snapshot({ current: version({ dataStatus: "deleted" }) }),
      snapshot({ current: version({ source: "manual_delete" }) }),
      snapshot({
        current: version({ contentUpdatedAt: "2026-11-02T00:00:00.000Z" }),
        synced,
        syncedAt: "2026-11-03T00:00:00.000Z",
      }),
      snapshot({
        current: version({ contentUpdatedAt: "2026-11-04T00:00:00.000Z", lines: [line({ qty: 9 })], qty: 9 }),
        synced,
        syncedAt: "2026-11-03T00:00:00.000Z",
        accurateNumber: "INV-1",
      }),
      snapshot({
        current: version({ status: "RETURNED", contentUpdatedAt: "2026-11-04T00:00:00.000Z" }),
        synced,
        syncedAt: "2026-11-03T00:00:00.000Z",
        accurateNumber: "INV-2",
        ppnReportDate: "2026-09-30",
      }),
      snapshot({
        current: version({ status: "CANCELED", contentUpdatedAt: "2026-11-04T00:00:00.000Z", day: "2026-09-01" }),
        synced,
        syncedAt: "2026-11-03T00:00:00.000Z",
        accurateNumber: "INV-3",
        ppnReportDate: "2026-09-30",
      }),
      snapshot({
        batchItems: [{ versionId: "v1", at: "2026-11-16T01:00:00.000Z", status: "gagal", error: "Pelanggan tidak ada" }],
        orderSyncs: [{ at: "2026-11-15T01:00:00.000Z", status: "gagal", error: "lama" }],
      }),
      snapshot({
        batchItems: [
          { versionId: "v1", at: "2026-11-16T01:00:00.000Z", status: "gagal", error: "gagal dulu" },
          { versionId: "v1", at: "2026-11-16T02:00:00.000Z", status: "berhasil", error: null },
        ],
      }),
      snapshot({
        current: version({ lossSibling: true, channel: "Internal", storeName: "Barang Hilang" }),
      }),
      snapshot({
        current: version({ status: "CANCELED" }),
      }),
    ];
    for (const row of rows) {
      expect(sqlDisplayedQueue(row)).toEqual(displayedQueue(row));
    }
    const failed = displayedQueue(rows[7]);
    expect(failed.shown).toBe(true);
    expect(failed.reason).toBe(SYNC_FAILED_REASON);
    expect(failed.failure).toBe("Pelanggan tidak ada");
  });

  it("loads 25 rows by default and leaves the rest for the next page", () => {
    const rows = Array.from({ length: 30 }, (_, index) => {
      const row = reviewOnly(index);
      return row;
    });
    const first = pageSyncReview(rows, { page: 0, pageSize: 25 });
    const second = pageSyncReview(rows, { page: 1, pageSize: 25 });
    expect(first.pageSize).toBe(25);
    expect(first.total).toBe(30);
    expect(first.rows).toHaveLength(25);
    expect(second.rows).toHaveLength(5);
    const firstNos = new Set(first.rows.map((row) => row.noPesanan));
    expect(second.rows.every((row) => !firstNos.has(row.noPesanan))).toBe(true);
    expect(pageSyncReview(rows, { page: 0, pageSize: 25, reason: "Gagal sync" }).total).toBe(0);
    expect(pageSyncReview(rows, { page: 0, pageSize: 25, reason: "Belum pernah sync" }).total).toBe(30);
  });
});

function reviewOnly(index: number) {
  const current = version({
    id: `v-${index}`,
    noPesanan: `SO-${String(index).padStart(2, "0")}`,
    day: `2026-11-${String((index % 28) + 1).padStart(2, "0")}`,
    storeName: index % 2 ? "Toko A" : "Toko B",
    channel: index % 2 ? "Shopee" : "Tokopedia",
  });
  const row = reviewRow(current, null, null);
  if (!row) throw new Error("expected a review row");
  return row;
}
