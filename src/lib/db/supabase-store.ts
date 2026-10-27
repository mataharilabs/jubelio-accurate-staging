import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sanitizeSettings } from "@/lib/db/defaults";
import { aggregateBatch, applyLinePatch, withWeights } from "@/lib/db/rules";
import type { DataStore, OrderSyncInput } from "@/lib/db/store";
import type {
  AccurateTokens,
  AppSettings,
  Batch,
  BundleWeight,
  CreateBatchInput,
  DashboardStats,
  LinePatch,
  OrderSync,
  SalesLine,
  SyncStatus,
} from "@/lib/db/types";
import { AppError } from "@/lib/errors";

type Row = Record<string, unknown>;

function num(value: unknown, fallback = 0): number {
  if (value == null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length ? text : null;
}

function lineFromRow(row: Row): SalesLine {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    rowIndex: num(row.row_index),
    noPesanan: String(row.no_pesanan ?? ""),
    noPesananSumber: str(row.no_pesanan_sumber),
    channel: String(row.channel ?? ""),
    sku: String(row.sku ?? ""),
    qty: num(row.qty),
    hargaJual: numOrNull(row.harga_jual),
    totalDiskon: numOrNull(row.total_diskon),
    tanggal: str(row.tanggal),
    lokasiGudang: str(row.lokasi_gudang),
    namaToko: str(row.nama_toko),
    status: str(row.status),
    namaBarang: str(row.nama_barang),
    sourceSku: str(row.source_sku),
    isBundle: Boolean(row.is_bundle),
    bundleKey: str(row.bundle_key),
    bobot: numOrNull(row.bobot),
    missingWeight: Boolean(row.missing_weight),
    isShopee: Boolean(row.is_shopee),
    syncStatus: (row.sync_status as SyncStatus) || "belum",
    sourceQty: num(row.source_qty),
    sourceHarga: num(row.source_harga),
    sourceTotalPenjualan: num(row.source_total_penjualan),
    sourceDiskon: num(row.source_diskon),
    sourceDiskonLainnya: num(row.source_diskon_lainnya),
    sourceBiayaLainnya: num(row.source_biaya_lainnya),
    sourceQtyBundle: num(row.source_qty_bundle),
  };
}

function lineToRow(line: SalesLine): Row {
  return {
    id: line.id,
    batch_id: line.batchId,
    row_index: line.rowIndex,
    no_pesanan: line.noPesanan,
    no_pesanan_sumber: line.noPesananSumber,
    channel: line.channel,
    sku: line.sku,
    qty: line.qty,
    harga_jual: line.hargaJual,
    total_diskon: line.totalDiskon,
    tanggal: line.tanggal,
    lokasi_gudang: line.lokasiGudang,
    nama_toko: line.namaToko,
    status: line.status,
    nama_barang: line.namaBarang,
    source_sku: line.sourceSku,
    is_bundle: line.isBundle,
    bundle_key: line.bundleKey,
    bobot: line.bobot,
    missing_weight: line.missingWeight,
    is_shopee: line.isShopee,
    sync_status: line.syncStatus,
    source_qty: line.sourceQty,
    source_harga: line.sourceHarga,
    source_total_penjualan: line.sourceTotalPenjualan,
    source_diskon: line.sourceDiskon,
    source_diskon_lainnya: line.sourceDiskonLainnya,
    source_biaya_lainnya: line.sourceBiayaLainnya,
    source_qty_bundle: line.sourceQtyBundle,
  };
}

function batchFromRow(row: Row): Batch {
  return {
    id: String(row.id),
    reportDate: String(row.report_date).slice(0, 10),
    filename: String(row.filename),
    rowCount: num(row.row_count),
    droppedCount: num(row.dropped_count),
    missingWeightCount: num(row.missing_weight_count),
    grossTotal: num(row.gross_total),
    discountTotal: num(row.discount_total),
    orderCount: num(row.order_count),
    unsyncedCount: num(row.unsynced_count),
    createdAt: String(row.created_at),
    createdBy: str(row.created_by),
  };
}

function syncFromRow(row: Row): OrderSync {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    noPesanan: String(row.no_pesanan),
    status: (row.status as SyncStatus) || "belum",
    accurateId: str(row.accurate_id),
    accurateNumber: str(row.accurate_number),
    payload: row.payload ?? null,
    response: row.response ?? null,
    error: str(row.error),
    syncedAt: str(row.synced_at),
    syncedBy: str(row.synced_by),
  };
}

function weightFromRow(row: Row): BundleWeight {
  return {
    id: String(row.id),
    bundleKey: String(row.bundle_key),
    bobot: num(row.bobot),
    updatedAt: String(row.updated_at),
  };
}

function unwrap<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) {
    if (/does not exist|schema cache|could not find the table/i.test(result.error.message)) {
      throw new AppError("Tabel Supabase belum ada. Jalankan SQL di supabase/migrations/0001_init.sql.");
    }
    throw new AppError(result.error.message, 500);
  }
  return result.data;
}

async function chunks<T>(items: T[], size: number, fn: (part: T[]) => Promise<void>) {
  for (let index = 0; index < items.length; index += size) {
    await fn(items.slice(index, index + size));
  }
}

export class SupabaseStore implements DataStore {
  mode = "supabase" as const;
  ephemeral = false;
  private db: SupabaseClient;

  constructor() {
    this.db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private async linesOf(batchId: string): Promise<SalesLine[]> {
    const data = unwrap(
      await this.db.from("sales_lines").select("*").eq("batch_id", batchId).order("row_index"),
    ) as Row[];
    return (data ?? []).map(lineFromRow);
  }

  private async touch(batchId: string) {
    const existing = unwrap(
      await this.db.from("batches").select("*").eq("id", batchId).maybeSingle(),
    ) as Row | null;
    if (!existing) return;
    const next = aggregateBatch(batchFromRow(existing), await this.linesOf(batchId));
    unwrap(
      await this.db
        .from("batches")
        .update({
          row_count: next.rowCount,
          missing_weight_count: next.missingWeightCount,
          gross_total: next.grossTotal,
          discount_total: next.discountTotal,
          order_count: next.orderCount,
          unsynced_count: next.unsyncedCount,
        })
        .eq("id", batchId),
    );
  }

  async dashboard() {
    const rows = unwrap(
      await this.db.from("batches").select("*").order("created_at", { ascending: false }),
    ) as Row[];
    const countResult = await this.db.from("bundle_weights").select("id", { count: "exact", head: true });
    if (countResult.error) unwrap(countResult);
    const batches = (rows ?? []).map(batchFromRow);
    const stats: DashboardStats = {
      batchCount: batches.length,
      lineCount: batches.reduce((sum, batch) => sum + batch.rowCount, 0),
      grossTotal: batches.reduce((sum, batch) => sum + batch.grossTotal, 0),
      discountTotal: batches.reduce((sum, batch) => sum + batch.discountTotal, 0),
      unsyncedOrders: batches.reduce((sum, batch) => sum + batch.unsyncedCount, 0),
      missingWeights: batches.reduce((sum, batch) => sum + batch.missingWeightCount, 0),
      weightCount: countResult.count ?? 0,
    };
    return { batches, stats };
  }

  async getBatchBundle(id: string) {
    const batchRow = unwrap(await this.db.from("batches").select("*").eq("id", id).maybeSingle()) as Row | null;
    if (!batchRow) return null;
    const lines = await this.linesOf(id);
    const syncRows = unwrap(await this.db.from("order_syncs").select("*").eq("batch_id", id)) as Row[];
    return { batch: batchFromRow(batchRow), lines, syncs: (syncRows ?? []).map(syncFromRow) };
  }

  async createBatch(input: CreateBatchInput) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const lines: SalesLine[] = input.lines.map((line) => ({
      ...line,
      id: crypto.randomUUID(),
      batchId: id,
      syncStatus: "belum" as const,
    }));
    const batch = aggregateBatch(
      {
        id,
        reportDate: input.reportDate,
        filename: input.filename,
        rowCount: 0,
        droppedCount: input.droppedCount,
        missingWeightCount: 0,
        grossTotal: 0,
        discountTotal: 0,
        orderCount: 0,
        unsyncedCount: 0,
        createdAt: now,
        createdBy: input.createdBy,
      },
      lines,
    );
    unwrap(
      await this.db.from("batches").insert({
        id: batch.id,
        report_date: batch.reportDate,
        filename: batch.filename,
        row_count: batch.rowCount,
        dropped_count: batch.droppedCount,
        missing_weight_count: batch.missingWeightCount,
        gross_total: batch.grossTotal,
        discount_total: batch.discountTotal,
        order_count: batch.orderCount,
        unsynced_count: batch.unsyncedCount,
        created_at: batch.createdAt,
        created_by: batch.createdBy,
      }),
    );
    try {
      await chunks(lines, 200, async (part) => {
        unwrap(await this.db.from("sales_lines").insert(part.map(lineToRow)));
      });
    } catch (error) {
      await this.db.from("batches").delete().eq("id", id);
      throw error;
    }
    return batch;
  }

  async deleteBatch(id: string) {
    unwrap(await this.db.from("batches").delete().eq("id", id));
  }

  async updateLine(id: string, patch: LinePatch) {
    const current = unwrap(await this.db.from("sales_lines").select("*").eq("id", id).maybeSingle()) as Row | null;
    if (!current) throw new AppError("Baris tidak ditemukan.", 404);
    const line = lineFromRow(current);
    const siblings = await this.linesOf(line.batchId);
    const next = applyLinePatch(line, patch, siblings);
    unwrap(await this.db.from("sales_lines").update(lineToRow(next)).eq("id", id));
    if (line.noPesanan !== next.noPesanan) {
      const remains = unwrap(
        await this.db
          .from("sales_lines")
          .select("id")
          .eq("batch_id", line.batchId)
          .eq("no_pesanan", line.noPesanan)
          .limit(1),
      ) as Row[];
      if (!remains?.length) {
        await this.db
          .from("order_syncs")
          .delete()
          .eq("batch_id", line.batchId)
          .eq("no_pesanan", line.noPesanan)
          .neq("status", "tersinkron");
      }
    }
    await this.touch(line.batchId);
    return next;
  }

  async deleteLines(ids: string[]) {
    if (!ids.length) return { deleted: 0, blocked: 0 };
    const rows = unwrap(await this.db.from("sales_lines").select("*").in("id", ids)) as Row[];
    const chosen = (rows ?? []).map(lineFromRow);
    const blocked = chosen.filter((row) => row.syncStatus === "tersinkron");
    const removed = chosen.filter((row) => row.syncStatus !== "tersinkron");
    if (removed.length) {
      unwrap(await this.db.from("sales_lines").delete().in("id", removed.map((row) => row.id)));
    }
    const seen = new Set<string>();
    for (const item of removed) {
      const key = `${item.batchId}\0${item.noPesanan}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const remains = unwrap(
        await this.db.from("sales_lines").select("id").eq("batch_id", item.batchId).eq("no_pesanan", item.noPesanan).limit(1),
      ) as Row[];
      if (!remains?.length) {
        await this.db
          .from("order_syncs")
          .delete()
          .eq("batch_id", item.batchId)
          .eq("no_pesanan", item.noPesanan)
          .neq("status", "tersinkron");
      }
    }
    for (const batchId of new Set(removed.map((row) => row.batchId))) await this.touch(batchId);
    return { deleted: removed.length, blocked: blocked.length };
  }

  async listWeights() {
    const rows = unwrap(await this.db.from("bundle_weights").select("*").order("bundle_key")) as Row[];
    return (rows ?? []).map(weightFromRow);
  }

  async upsertWeights(rows: { bundleKey: string; bobot: number }[], replace: boolean) {
    if (replace) unwrap(await this.db.from("bundle_weights").delete().neq("id", "00000000-0000-0000-0000-000000000000"));
    const now = new Date().toISOString();
    const payload = rows
      .map((row) => ({ bundle_key: row.bundleKey.trim(), bobot: row.bobot, updated_at: now }))
      .filter((row) => row.bundle_key);
    for (const row of payload) {
      if (!Number.isFinite(row.bobot) || row.bobot < 0) throw new AppError(`Bobot tidak valid untuk ${row.bundle_key}.`);
    }
    await chunks(payload, 200, async (part) => {
      unwrap(await this.db.from("bundle_weights").upsert(part, { onConflict: "bundle_key" }));
    });
    const count = await this.db.from("bundle_weights").select("id", { count: "exact", head: true });
    return count.count ?? payload.length;
  }

  async updateWeight(id: string, patch: { bundleKey?: string; bobot?: number }) {
    const current = unwrap(await this.db.from("bundle_weights").select("*").eq("id", id).maybeSingle()) as Row | null;
    if (!current) throw new AppError("Bobot tidak ditemukan.", 404);
    const next = weightFromRow(current);
    if (patch.bundleKey != null) {
      const bundleKey = patch.bundleKey.trim();
      if (!bundleKey) throw new AppError("Kunci bundle tidak boleh kosong.");
      const clash = unwrap(
        await this.db.from("bundle_weights").select("id").eq("bundle_key", bundleKey).neq("id", id).limit(1),
      ) as Row[];
      if (clash?.length) throw new AppError("Kunci bundle sudah ada.");
      next.bundleKey = bundleKey;
    }
    if (patch.bobot != null) {
      if (!Number.isFinite(patch.bobot) || patch.bobot < 0) throw new AppError("Bobot tidak valid.");
      next.bobot = patch.bobot;
    }
    next.updatedAt = new Date().toISOString();
    unwrap(
      await this.db
        .from("bundle_weights")
        .update({ bundle_key: next.bundleKey, bobot: next.bobot, updated_at: next.updatedAt })
        .eq("id", id),
    );
    return next;
  }

  async deleteWeight(id: string) {
    unwrap(await this.db.from("bundle_weights").delete().eq("id", id));
  }

  async weightMap() {
    const weights = await this.listWeights();
    return new Map(weights.map((row) => [row.bundleKey, row.bobot]));
  }

  async getSettings() {
    const row = unwrap(await this.db.from("app_settings").select("data").eq("id", 1).maybeSingle()) as { data?: unknown } | null;
    return sanitizeSettings(row?.data ?? null);
  }

  async saveSettings(settings: AppSettings) {
    const data = sanitizeSettings(settings);
    unwrap(
      await this.db.from("app_settings").upsert({ id: 1, data, updated_at: new Date().toISOString() }),
    );
    return data;
  }

  async getTokens() {
    const row = unwrap(await this.db.from("accurate_tokens").select("*").eq("id", 1).maybeSingle()) as Row | null;
    if (!row?.access_token) return null;
    return {
      accessToken: String(row.access_token),
      refreshToken: str(row.refresh_token),
      expiresAt: str(row.expires_at),
      scope: str(row.scope),
      userEmail: str(row.user_email),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    };
  }

  async saveTokens(tokens: AccurateTokens | null) {
    if (!tokens) {
      unwrap(await this.db.from("accurate_tokens").delete().eq("id", 1));
      return;
    }
    unwrap(
      await this.db.from("accurate_tokens").upsert({
        id: 1,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
        scope: tokens.scope,
        user_email: tokens.userEmail,
        updated_at: tokens.updatedAt,
      }),
    );
  }

  async linesForOrders(batchId: string, orderNos: string[]) {
    if (!orderNos.length) return [];
    const rows = unwrap(
      await this.db.from("sales_lines").select("*").eq("batch_id", batchId).in("no_pesanan", orderNos).order("row_index"),
    ) as Row[];
    return (rows ?? []).map(lineFromRow);
  }

  async saveOrderSync(input: OrderSyncInput) {
    const existing = unwrap(
      await this.db
        .from("order_syncs")
        .select("*")
        .eq("batch_id", input.batchId)
        .eq("no_pesanan", input.noPesanan)
        .maybeSingle(),
    ) as Row | null;
    if (existing && existing.status === "tersinkron" && input.status === "tersinkron") {
      throw new AppError(`Pesanan ${input.noPesanan} sudah tersinkron.`);
    }
    if (input.status === "tersinkron") {
      const other = await this.findSyncedElsewhere(input.noPesanan, input.batchId);
      if (other) throw new AppError(`Pesanan ${input.noPesanan} sudah tersinkron di batch lain.`);
    }
    const now = new Date().toISOString();
    const row = {
      id: existing?.id ? String(existing.id) : crypto.randomUUID(),
      batch_id: input.batchId,
      no_pesanan: input.noPesanan,
      status: input.status,
      accurate_id: input.accurateId === undefined ? existing?.accurate_id ?? null : input.accurateId,
      accurate_number: input.accurateNumber === undefined ? existing?.accurate_number ?? null : input.accurateNumber,
      payload: input.payload === undefined ? existing?.payload ?? null : input.payload,
      response: input.response === undefined ? existing?.response ?? null : input.response,
      error: input.error === undefined ? existing?.error ?? null : input.error,
      synced_at: input.syncedAt === undefined ? existing?.synced_at ?? null : input.syncedAt,
      synced_by: input.syncedBy === undefined ? existing?.synced_by ?? null : input.syncedBy,
      updated_at: now,
    };
    if (input.status === "tersinkron" && !row.synced_at) row.synced_at = now;
    const saved = unwrap(
      await this.db.from("order_syncs").upsert(row, { onConflict: "batch_id,no_pesanan" }).select("*").single(),
    ) as Row;
    unwrap(
      await this.db
        .from("sales_lines")
        .update({ sync_status: input.status })
        .eq("batch_id", input.batchId)
        .eq("no_pesanan", input.noPesanan),
    );
    await this.touch(input.batchId);
    return syncFromRow(saved);
  }

  async findSyncedElsewhere(noPesanan: string, batchId: string) {
    const row = unwrap(
      await this.db
        .from("order_syncs")
        .select("*")
        .eq("no_pesanan", noPesanan)
        .eq("status", "tersinkron")
        .neq("batch_id", batchId)
        .limit(1)
        .maybeSingle(),
    ) as Row | null;
    return row ? syncFromRow(row) : null;
  }

  async resetOrder(batchId: string, noPesanan: string) {
    await this.db
      .from("order_syncs")
      .update({ status: "belum", error: null, updated_at: new Date().toISOString() })
      .eq("batch_id", batchId)
      .eq("no_pesanan", noPesanan);
    unwrap(
      await this.db
        .from("sales_lines")
        .update({ sync_status: "belum" })
        .eq("batch_id", batchId)
        .eq("no_pesanan", noPesanan),
    );
    await this.touch(batchId);
  }

  async recalcBatch(batchId: string) {
    const weights = await this.weightMap();
    const lines = await this.linesOf(batchId);
    let updated = 0;
    let skipped = 0;
    const changed: SalesLine[] = [];
    for (const line of lines) {
      if (line.syncStatus === "tersinkron") {
        skipped += 1;
        continue;
      }
      changed.push(withWeights(line, weights));
      updated += 1;
    }
    await chunks(changed, 25, async (part) => {
      await Promise.all(part.map((line) => this.db.from("sales_lines").update(lineToRow(line)).eq("id", line.id)));
    });
    await this.touch(batchId);
    return { updated, skipped };
  }
}
