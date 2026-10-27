import { buildInvoice, invoiceUrl } from "@/lib/accurate/invoice";
import type { OrderPreview } from "@/lib/sync-types";
import {
  openDatabase,
  refreshTokens,
  saveSalesInvoice,
  tokenNeedsRefresh,
} from "@/lib/accurate/client";
import { getStore } from "@/lib/db";
import type { SalesLine } from "@/lib/db/types";
import { accurateEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

const inflight = new Set<string>();

export type SyncSelection = {
  batchId: string;
  lineIds?: string[];
  orderNos?: string[];
};

export type { OrderPreview };

async function resolve(selection: SyncSelection) {
  const store = await getStore();
  const bundle = await store.getBatchBundle(selection.batchId);
  if (!bundle) throw new AppError("Batch tidak ditemukan.", 404);
  const selectedCount = new Map<string, number>();
  let orderNos: string[];
  if (selection.orderNos?.length) {
    orderNos = [...new Set(selection.orderNos)];
  } else if (selection.lineIds?.length) {
    const ids = new Set(selection.lineIds);
    const chosen = bundle.lines.filter((line) => ids.has(line.id));
    if (!chosen.length) throw new AppError("Tidak ada baris yang dipilih.");
    orderNos = [...new Set(chosen.map((line) => line.noPesanan))];
    for (const line of chosen) selectedCount.set(line.noPesanan, (selectedCount.get(line.noPesanan) ?? 0) + 1);
  } else {
    orderNos = [...new Set(bundle.lines.map((line) => line.noPesanan))];
  }
  const orders = orderNos
    .map((noPesanan) => {
      const lines = bundle.lines.filter((line) => line.noPesanan === noPesanan);
      return {
        noPesanan,
        lines,
        selectedLineCount: selectedCount.get(noPesanan) ?? lines.length,
      };
    })
    .filter((order) => order.lines.length);
  if (!orders.length) throw new AppError("Tidak ada pesanan yang bisa diproses.");
  return { store, bundle, orders };
}

function previewStatus(current: SalesLine["syncStatus"], blocked: boolean): SalesLine["syncStatus"] {
  if (blocked) return current === "gagal" ? "gagal" : "belum";
  return "pratinjau";
}

export async function previewOrders(selection: SyncSelection): Promise<OrderPreview[]> {
  const { store, bundle, orders } = await resolve(selection);
  const settings = await store.getSettings();
  const syncByOrder = new Map(bundle.syncs.map((sync) => [sync.noPesanan, sync]));
  const previews: OrderPreview[] = [];
  for (const order of orders) {
    const current = order.lines[0]?.syncStatus ?? "belum";
    const elsewhere = await store.findSyncedElsewhere(order.noPesanan, selection.batchId);
    const draft = buildInvoice(order.lines, settings, bundle.batch.reportDate);
    const known = syncByOrder.get(order.noPesanan);
    let skippedReason: string | null = null;
    if (current === "tersinkron" || elsewhere) {
      skippedReason = elsewhere
        ? `Sudah tersinkron di batch lain${elsewhere.accurateNumber ? ` (${elsewhere.accurateNumber})` : ""}.`
        : `Sudah tersinkron${known?.accurateNumber ? ` sebagai ${known.accurateNumber}` : ""}.`;
    } else {
      if (order.selectedLineCount < order.lines.length) {
        draft.warnings.push(
          `Faktur memuat seluruh ${order.lines.length} baris pesanan, termasuk yang tidak dicentang.`,
        );
      }
      await store.saveOrderSync({
        batchId: selection.batchId,
        noPesanan: order.noPesanan,
        status: previewStatus(current, Boolean(draft.blockedReason)),
        payload: draft,
        error: draft.blockedReason,
      });
    }
    previews.push({
      ...draft,
      lineCount: order.lines.length,
      selectedLineCount: order.selectedLineCount,
      syncStatus: current,
      accurateNumber: known?.accurateNumber ?? elsewhere?.accurateNumber ?? null,
      skippedReason,
    });
  }
  return previews;
}

export async function executeOrders(selection: SyncSelection, actor: string) {
  const { store, bundle, orders } = await resolve(selection);
  let tokens = await store.getTokens();
  if (!tokens?.accessToken) {
    throw new AppError("Accurate belum terhubung. Payload bisa dilihat lewat pratinjau. Hubungkan akun di Pengaturan setelah kredensial diisi.");
  }
  if (tokenNeedsRefresh(tokens)) {
    tokens = await refreshTokens(tokens);
    await store.saveTokens(tokens);
  }
  const settings = await store.getSettings();
  const databaseId = settings.accurateDatabaseId || accurateEnv().databaseId;
  if (!databaseId) {
    throw new AppError("ID database Accurate belum diisi. Isi di Pengaturan atau lewat ACCURATE_DATABASE_ID.");
  }
  const opened = await openDatabase(tokens.accessToken, databaseId);
  const results: { noPesanan: string; status: "tersinkron" | "gagal" | "dilewati"; accurateNumber: string | null; error: string | null }[] = [];

  for (const order of orders) {
    const key = `${selection.batchId}:${order.noPesanan}`;
    const fresh = await store.linesForOrders(selection.batchId, [order.noPesanan]);
    const elsewhere = await store.findSyncedElsewhere(order.noPesanan, selection.batchId);
    if (fresh.some((line) => line.syncStatus === "tersinkron") || elsewhere || inflight.has(key)) {
      results.push({
        noPesanan: order.noPesanan,
        status: "dilewati",
        accurateNumber: elsewhere?.accurateNumber ?? null,
        error: elsewhere ? "Sudah tersinkron di batch lain." : "Sudah tersinkron.",
      });
      continue;
    }
    const draft = buildInvoice(fresh.length ? fresh : order.lines, settings, bundle.batch.reportDate, invoiceUrl(opened.host));
    if (draft.blockedReason) {
      await store.saveOrderSync({
        batchId: selection.batchId,
        noPesanan: order.noPesanan,
        status: "gagal",
        payload: draft,
        error: draft.blockedReason,
      });
      results.push({ noPesanan: order.noPesanan, status: "gagal", accurateNumber: null, error: draft.blockedReason });
      continue;
    }
    inflight.add(key);
    try {
      const saved = await saveSalesInvoice(tokens.accessToken, opened.host, opened.session, draft);
      await store.saveOrderSync({
        batchId: selection.batchId,
        noPesanan: order.noPesanan,
        status: "tersinkron",
        accurateId: saved.accurateId,
        accurateNumber: saved.accurateNumber,
        payload: draft,
        response: saved.response,
        error: null,
        syncedAt: new Date().toISOString(),
        syncedBy: actor,
      });
      results.push({
        noPesanan: order.noPesanan,
        status: "tersinkron",
        accurateNumber: saved.accurateNumber,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal menyimpan faktur.";
      const response = error instanceof AppError && "response" in error ? (error as AppError & { response?: unknown }).response ?? null : null;
      await store.saveOrderSync({
        batchId: selection.batchId,
        noPesanan: order.noPesanan,
        status: "gagal",
        payload: draft,
        response,
        error: message,
      });
      results.push({ noPesanan: order.noPesanan, status: "gagal", accurateNumber: null, error: message });
    } finally {
      inflight.delete(key);
    }
  }
  return results;
}
