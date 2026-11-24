import type { SyncReviewPage, SyncReviewQuery } from "@/lib/db/store";
import type { OrderVersion, SyncCategory, SyncReviewRow, SyncState } from "@/lib/db/types";
import { diffVersions } from "@/lib/domain/orders";
import { accurateIntent, needsAccurateSync, syncFailureForVersion, syncReason, type SyncAttempt } from "@/lib/domain/phase3";
import { reviewRow } from "@/lib/domain/review-rows";
import { clampPageSize } from "@/lib/page-size";

/**
 * SQL-shaped copies of the queue rules. supabase/migrations/0015_sync_queue.sql
 * must stay aligned with these functions. The parity test compares them with
 * needsAccurateSync, syncFailureForVersion, syncReason, and accurateIntent.
 */
export function sqlQueueMember(input: {
  dataStatus?: string | null;
  contentUpdatedAt?: string | null;
  syncedAt?: string | null;
}): boolean {
  if (input.dataStatus === "deleted") return false;
  if (!input.syncedAt) return true;
  if (!input.contentUpdatedAt) return false;
  return input.contentUpdatedAt > input.syncedAt;
}

const SQL_SYNC_SUCCESS = new Set(["berhasil", "tersinkron"]);
const SQL_SYNC_FAILURE = new Set(["gagal"]);

function sqlAttemptTime(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Latest gagal until a later success. Batch rows match version id; legacy rows have no version. */
export function sqlSyncFailure(input: {
  versionId: string;
  versionCreatedAt?: string | null;
  batchItems: SyncAttempt[];
  orderSyncs?: SyncAttempt[];
}): string | null {
  const createdAt = sqlAttemptTime(input.versionCreatedAt ?? "");
  const fromBatch = input.batchItems.filter((item) => item.versionId === input.versionId && (SQL_SYNC_SUCCESS.has(item.status) || SQL_SYNC_FAILURE.has(item.status)));
  const fromLegacy = (input.orderSyncs ?? []).filter((item) => {
    if (!SQL_SYNC_SUCCESS.has(item.status) && !SQL_SYNC_FAILURE.has(item.status)) return false;
    if (!createdAt) return true;
    return sqlAttemptTime(item.at) >= createdAt;
  });
  const attempts = [...fromBatch, ...fromLegacy].sort((a, b) => sqlAttemptTime(b.at) - sqlAttemptTime(a.at));
  const latest = attempts[0];
  if (!latest || !SQL_SYNC_FAILURE.has(latest.status)) return null;
  return latest.error?.trim() || "Sync gagal.";
}

export function sqlSyncReason(category: string, everSynced: boolean, failed: boolean): string {
  if (failed) return "Gagal sync";
  if (!everSynced || category === "Baru") return "Belum pernah sync";
  if (category === "Returned") return "Status jadi RETURNED";
  if (category === "Batal") return "Status jadi CANCELED";
  if (category === "Berubah") return "Data berubah";
  return category;
}

export function sqlClassify(current: OrderVersion | null, synced: OrderVersion | null): SyncCategory | null {
  if (!current) return null;
  const everSynced = Boolean(synced);
  if (current.source === "manual_delete") return everSynced ? "Batal" : null;
  const status = (current.status ?? "").toUpperCase();
  if (current.source === "cancel" || status === "CANCELED" || status === "CANCELLED" || status === "CANCEL") return "Batal";
  if (!everSynced || !synced) return "Baru";
  const changes = diffVersions(synced, current);
  if (!changes.length) return "Sama";
  const statusChanged = changes.some((change) => change.field === "header.status");
  const becameReturned = current.status.toUpperCase() === "RETURNED" && synced.status.toUpperCase() !== "RETURNED";
  const dataChanged = changes.some((change) => change.field !== "header.status");
  if (becameReturned) return "Returned";
  if (dataChanged) return "Berubah";
  if (statusChanged) return "Status saja";
  return "Sama";
}

export function sqlAccurateAction(input: {
  status: string;
  everSynced: boolean;
  orderDay: string;
  ppnReportDate?: string | null;
  lossSibling?: boolean;
}): string {
  const status = input.status.trim().toUpperCase();
  const closed = Boolean(input.ppnReportDate && input.orderDay) && input.orderDay.slice(0, 10) <= String(input.ppnReportDate).slice(0, 10);
  const cancel = status === "CANCELED" || status === "CANCELLED" || status === "CANCEL";
  const returned = status === "RETURNED";
  if (cancel && !input.everSynced) return "Tidak dikirim (cancel sebelum sync)";
  if (returned && !input.everSynced) return "Tidak dikirim (retur sebelum sync)";
  if (cancel && closed) return "Tidak diproses otomatis";
  if (cancel) return "Hapus penjualan";
  if (returned && closed) return "Buat Retur penjualan";
  if (returned) return "Hapus penjualan";
  if (!input.everSynced && input.lossSibling) return "Buat penjualan (Barang Hilang)";
  if (!input.everSynced) return "Buat penjualan";
  return "Ubah penjualan";
}

export type QueueSnapshot = {
  current: OrderVersion;
  synced: OrderVersion | null;
  syncedAt?: string | null;
  accurateNumber?: string | null;
  batchItems: SyncAttempt[];
  orderSyncs?: SyncAttempt[];
  ppnReportDate?: string | null;
};

export type QueueDecision = {
  member: boolean;
  shown: boolean;
  reason: string | null;
  failure: string | null;
  action: string | null;
};

/** What the Pesanan list shows: needsAccurateSync, then reviewRow, then reason and action. */
export function displayedQueue(input: QueueSnapshot): QueueDecision {
  const member = needsAccurateSync({
    dataStatus: input.current.dataStatus,
    contentUpdatedAt: input.current.contentUpdatedAt,
    syncedAt: input.syncedAt,
  });
  const state: SyncState = {
    noPesanan: input.current.noPesanan,
    lastSyncedVersionId: input.synced?.id ?? null,
    accurateId: null,
    accurateNumber: input.accurateNumber ?? null,
    lastSyncStatus: null,
    decision: null,
    decisionVersionId: null,
    updatedAt: input.current.createdAt,
    syncedAt: input.syncedAt ?? null,
  };
  const row = reviewRow(input.current, input.synced, state);
  if (!member || !row) return { member, shown: false, reason: null, failure: null, action: null };
  const failure = syncFailureForVersion({
    versionId: input.current.id,
    versionCreatedAt: input.current.createdAt,
    batchItems: input.batchItems,
    orderSyncs: input.orderSyncs,
  });
  row.lastSyncError = failure;
  const described = describeReviewRow(row, input.ppnReportDate);
  return { member, shown: true, reason: described.why, failure, action: described.action };
}

/** Same decision, computed by the SQL-shaped helpers instead of the original functions. */
export function sqlDisplayedQueue(input: QueueSnapshot): QueueDecision {
  const member = sqlQueueMember({
    dataStatus: input.current.dataStatus,
    contentUpdatedAt: input.current.contentUpdatedAt,
    syncedAt: input.syncedAt,
  });
  const category = sqlClassify(input.current, input.synced);
  if (!member || !category) return { member, shown: false, reason: null, failure: null, action: null };
  const failure = sqlSyncFailure({
    versionId: input.current.id,
    versionCreatedAt: input.current.createdAt,
    batchItems: input.batchItems,
    orderSyncs: input.orderSyncs,
  });
  const everSynced = Boolean(input.synced || input.accurateNumber);
  return {
    member,
    shown: true,
    reason: sqlSyncReason(category, everSynced, Boolean(failure)),
    failure,
    action: sqlAccurateAction({
      status: input.current.status,
      everSynced,
      orderDay: input.current.day,
      ppnReportDate: input.ppnReportDate,
      lossSibling: Boolean(input.current.lossSibling),
    }),
  };
}

export type DescribedReview = {
  row: SyncReviewRow;
  why: string;
  action: string;
};

export function describeReviewRow(row: SyncReviewRow, ppnReportDate?: string | null): DescribedReview {
  const everSynced = Boolean(row.baseline || row.accurateNumber);
  return {
    row,
    why: syncReason(row.category, everSynced, Boolean(row.lastSyncError)),
    action: accurateIntent({
      status: row.current.status,
      everSynced,
      orderDay: row.day,
      ppnReportDate,
      lossSibling: Boolean(row.current.lossSibling),
    }).label,
  };
}

function matchesReview(item: DescribedReview, query: SyncReviewQuery, storeAndChannel: boolean): boolean {
  if (!needsAccurateSync({
    dataStatus: item.row.current.dataStatus,
    contentUpdatedAt: item.row.current.contentUpdatedAt,
    syncedAt: item.row.syncedAt,
  })) return false;
  const q = (query.q ?? "").toLowerCase();
  if (q && !`${item.row.noPesanan} ${item.row.current.customerName} ${item.row.current.storeName}`.toLowerCase().includes(q)) return false;
  if (query.from && item.row.day < query.from) return false;
  if (query.to && item.row.day > query.to) return false;
  if (query.days?.length && !query.days.includes(item.row.day)) return false;
  if (query.reason && item.why !== query.reason) return false;
  if (query.action && item.action !== query.action) return false;
  if (storeAndChannel) {
    if (query.store && item.row.current.storeName !== query.store) return false;
    if (query.channel && item.row.current.channel !== query.channel) return false;
  }
  return true;
}

/** Asked of sync_queue. The deployed function clamps this to at most 200. */
export const SYNC_EXPORT_PAGE = 1000;
export const SYNC_EXPORT_PARALLEL = 8;

export function syncExportPageSize(returned: number, fallback = 200): number {
  return returned > 0 ? returned : fallback;
}

/** Page numbers after the first page. Empty when the first page already holds every row. */
export function syncExportRestPages(total: number, pageSize: number): number[] {
  if (pageSize <= 0 || total <= pageSize) return [];
  const count = Math.ceil(total / pageSize);
  return Array.from({ length: count - 1 }, (_, index) => index + 1);
}

export function syncQueueEmptyText(input: { failed: boolean; filtered: boolean }): string {
  if (input.failed) return "Gagal memuat data pesanan.";
  if (input.filtered) return "Tidak ada pesanan untuk filter ini.";
  return "Semua pesanan sudah tersinkron ke Accurate.";
}

export function syncLogEmptyText(failed: boolean): string {
  return failed ? "Gagal memuat log sinkron." : "Belum ada log.";
}

/** In-memory page used by the local store. Same filters as sync_queue. Default page size is 25. */
export function pageSyncReview(rows: SyncReviewRow[], query: SyncReviewQuery, ppnReportDate?: string | null): SyncReviewPage {
  const pageSize = clampPageSize(query.pageSize, 25);
  const page = Math.max(0, query.page || 0);
  const described = rows.map((row) => describeReviewRow(row, ppnReportDate));
  const scoped = described.filter((item) => matchesReview(item, query, false));
  const filtered = scoped.filter((item) => matchesReview(item, query, true));
  const stores = [...new Set(scoped.map((item) => item.row.current.storeName).filter(Boolean))].sort();
  const channels = [...new Set(scoped.map((item) => item.row.current.channel).filter(Boolean))].sort();
  const start = page * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize).map((item) => item.row),
    total: filtered.length,
    page,
    pageSize,
    facets: { stores, channels },
  };
}
