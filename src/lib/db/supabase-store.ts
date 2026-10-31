import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CleanLine } from "@/lib/cleanup/rapikan";
import { sanitizeSettings } from "@/lib/db/defaults";
import { bucketLabel } from "@/lib/domain/aggregate";
import { applyLineEdit, diffVersions, orderRevenue } from "@/lib/domain/orders";
import { planCancels, planImport } from "@/lib/domain/plan";
import { reviewRow } from "@/lib/domain/review-rows";
import type { DataStore, PreparedSync, SyncWrite } from "@/lib/db/store";
import type {
  AccurateTokens,
  AppMeta,
  AppSettings,
  BundleWeight,
  ChannelMapRow,
  CityMapRow,
  DashboardQuery,
  DashboardReport,
  FieldChange,
  FilterOptions,
  ImportRecord,
  ImportResult,
  OrderLine,
  OrderPage,
  OrderQuery,
  OrderVersion,
  ProvinceMapRow,
  ReviewItem,
  SyncBatch,
  SyncBatchItem,
  SyncReviewRow,
  SyncState,
  VersionSource,
} from "@/lib/db/types";
import { accurateConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
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

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function client(): SupabaseClient {
  const url = supabaseUrl();
  const key = supabaseServiceKey();
  if (!url || !key) throw new AppError("Supabase belum dikonfigurasi.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function explain(error: { message?: string; code?: string } | null, action: string): never {
  const missing = error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|schema cache/i.test(error?.message ?? "");
  if (missing) {
    throw new AppError("Tabel baru belum ada di Supabase. Jalankan supabase/migrations/0002_ecommerce.sql di SQL Editor.");
  }
  throw new AppError(error?.message || `Gagal ${action}.`);
}

async function must<T>(promise: PromiseLike<{ data: T; error: { message?: string; code?: string } | null }>, action: string): Promise<T> {
  const { data, error } = await promise;
  if (error) explain(error, action);
  return data;
}

function lineFrom(row: Row): OrderLine {
  return {
    id: str(row.id),
    sku: str(row.sku),
    productName: str(row.product_name),
    qty: num(row.qty),
    unitPrice: numOrNull(row.unit_price),
    subTotal: numOrNull(row.sub_total),
    unitDiskon: numOrNull(row.unit_diskon),
    revenuePerUnit: numOrNull(row.revenue_per_unit),
    missingWeight: Boolean(row.missing_weight),
    bundleKey: strOrNull(row.bundle_key),
    unitCogs: numOrNull(row.unit_cogs),
    flags: Array.isArray(row.flags) ? row.flags.map(String) : [],
  };
}

function versionFrom(row: Row, lines: OrderLine[]): OrderVersion {
  const tanggal = row.tanggal ? new Date(String(row.tanggal)).toISOString().replace(".000Z", "") : "";
  return {
    id: str(row.id),
    noPesanan: str(row.no_pesanan),
    versionNo: num(row.version_no),
    importId: strOrNull(row.import_id),
    source: str(row.source) as VersionSource,
    createdAt: str(row.created_at),
    createdBy: strOrNull(row.created_by),
    isCurrent: Boolean(row.is_current),
    tanggal,
    day: row.order_day ? String(row.order_day).slice(0, 10) : tanggal.slice(0, 10),
    channel: str(row.channel),
    storeName: str(row.store_name),
    customerName: str(row.customer_name),
    customerCode: str(row.customer_code),
    province: str(row.province),
    city: str(row.city),
    kurir: str(row.kurir),
    status: str(row.status),
    lokasiGudang: strOrNull(row.lokasi_gudang),
    totalNilaiPesanan: numOrNull(row.total_nilai_pesanan),
    totalDiskon: num(row.total_diskon),
    qty: num(row.qty),
    revenue: numOrNull(row.revenue),
    lines,
  };
}

function versionRow(version: OrderVersion): Row {
  return {
    id: version.id,
    no_pesanan: version.noPesanan,
    version_no: version.versionNo,
    import_id: version.importId,
    source: version.source,
    created_at: version.createdAt,
    created_by: version.createdBy,
    is_current: version.isCurrent,
    tanggal: version.tanggal ? new Date(version.tanggal.endsWith("Z") ? version.tanggal : `${version.tanggal}Z`).toISOString() : null,
    order_day: version.day || null,
    channel: version.channel,
    store_name: version.storeName,
    customer_name: version.customerName,
    customer_code: version.customerCode,
    province: version.province,
    city: version.city,
    kurir: version.kurir,
    status: version.status,
    lokasi_gudang: version.lokasiGudang,
    total_nilai_pesanan: version.totalNilaiPesanan,
    total_diskon: version.totalDiskon,
    qty: version.qty,
    revenue: version.revenue,
  };
}

export class SupabaseStore implements DataStore {
  mode = "supabase" as const;
  ephemeral = false;
  private sb = client();

  async ensureSeeded(): Promise<void> {
    const weights = await this.listWeights().catch(() => null);
    if (weights && weights.length === 0) {
      const { seedReferenceData } = await import("@/lib/sample-data");
      await seedReferenceData(this);
    }
  }

  private async linesFor(versionIds: string[]): Promise<Map<string, OrderLine[]>> {
    const map = new Map<string, OrderLine[]>();
    for (let i = 0; i < versionIds.length; i += 100) {
      const slice = versionIds.slice(i, i + 100);
      const data = await must(this.sb.from("order_lines").select("*").in("version_id", slice).order("line_no"), "membaca baris");
      for (const row of (data ?? []) as Row[]) {
        const id = str(row.version_id);
        const list = map.get(id) ?? [];
        list.push(lineFrom(row));
        map.set(id, list);
      }
    }
    return map;
  }

  private async hydrate(rows: Row[]): Promise<OrderVersion[]> {
    const lines = await this.linesFor(rows.map((row) => str(row.id)));
    return rows.map((row) => versionFrom(row, lines.get(str(row.id)) ?? []));
  }

  async currentVersions(): Promise<OrderVersion[]> {
    const data = await must(this.sb.from("order_versions").select("*").eq("is_current", true), "membaca versi");
    return this.hydrate((data ?? []) as Row[]);
  }

  async meta(): Promise<AppMeta> {
    const [imports, current, reviews, lines, tokens] = await Promise.all([
      this.sb.from("imports").select("created_at").order("created_at", { ascending: false }).limit(1),
      this.sb.from("order_versions").select("source").eq("is_current", true),
      this.sb.from("review_items").select("id").eq("status", "open"),
      this.sb.from("v_sales_current").select("line_id", { count: "exact", head: true }),
      this.getTokens(),
    ]);
    if (imports.error) explain(imports.error, "membaca impor");
    if (current.error) explain(current.error, "menghitung pesanan");
    if (reviews.error) explain(reviews.error, "menghitung review");
    const active = ((current.data ?? []) as Row[]).filter((row) => row.source !== "cancel" && row.source !== "manual_delete");
    return {
      mode: "supabase",
      ephemeral: false,
      lastImportAt: imports.data?.[0] ? str((imports.data[0] as Row).created_at) : null,
      orderCount: active.length,
      lineCount: lines.count ?? 0,
      openReviews: (reviews.data ?? []).length,
      accurateConnected: Boolean(tokens?.accessToken),
      accurateConfigured: accurateConfigured(),
      accurateUser: tokens?.userEmail ?? null,
    };
  }

  async dashboard(query: DashboardQuery): Promise<DashboardReport> {
    const data = await must(this.sb.rpc("dashboard_report", {
      p: {
        from: query.from,
        to: query.to,
        granularity: query.granularity,
        channels: query.channels,
        stores: query.stores,
        provinces: query.provinces,
        cities: query.cities,
        statuses: query.statuses,
        couriers: query.couriers,
        skus: query.skus,
      },
    }), "menghitung dasbor");
    const raw = data as DashboardReport;
    const net = Number(raw.kpis?.net ?? 0);
    return {
      ...raw,
      kpis: {
        gross: Number(raw.kpis.gross),
        disc: Number(raw.kpis.disc),
        net,
        orders: Number(raw.kpis.orders),
        qty: Number(raw.kpis.qty),
        aov: Number(raw.kpis.aov),
        days: Number(raw.kpis.days),
      },
      trend: (raw.trend ?? []).map((row) => ({
        ...row,
        gross: Number(row.gross),
        net: Number(row.net),
        orders: Number(row.orders),
        label: bucketLabel(row.bucket, query.granularity),
      })),
      channels: (raw.channels ?? []).map(numberGroup),
      stores: (raw.stores ?? []).map(numberGroup),
      products: (raw.products ?? []).map((row) => ({
        ...numberGroup(row),
        sku: row.sku,
        name: row.name ?? "",
        share: net ? Number(row.net) / net : 0,
      })),
      provinces: (raw.provinces ?? []).map((row) => ({
        key: row.key,
        net: Number(row.net),
        qty: Number(row.qty),
        orders: Number(row.orders),
        share: net ? Number(row.net) / net : 0,
      })),
      cities: (raw.cities ?? []).map((row) => ({
        key: row.key,
        net: Number(row.net),
        qty: Number(row.qty),
        orders: Number(row.orders),
        share: net ? Number(row.net) / net : 0,
      })),
    };
  }

  async filterOptions(): Promise<FilterOptions> {
    const data = await must(this.sb.rpc("dashboard_options"), "membaca pilihan filter");
    const raw = data as FilterOptions;
    return {
      channels: raw.channels ?? [],
      stores: raw.stores ?? [],
      provinces: raw.provinces ?? [],
      cities: raw.cities ?? [],
      statuses: raw.statuses ?? [],
      couriers: raw.couriers ?? [],
      skus: raw.skus ?? [],
      minDay: raw.minDay ?? null,
      maxDay: raw.maxDay ?? null,
    };
  }

  async listOrders(query: OrderQuery): Promise<OrderPage> {
    const versions = await this.currentVersions();
    return pageVersions(versions, query);
  }

  private async writePlan(plan: ReturnType<typeof planImport>, record: ImportRecord | null) {
    if (plan.retireIds.length) {
      const { error } = await this.sb.from("order_versions").update({ is_current: false }).in("id", plan.retireIds);
      if (error) explain(error, "menutup versi lama");
    }
    if (record) {
      const { error } = await this.sb.from("imports").insert({
        id: record.id,
        filename: record.filename,
        source: record.source,
        created_at: record.createdAt,
        created_by: record.createdBy,
        order_count: record.orderCount,
        line_count: record.lineCount,
        new_versions: record.newVersions,
        unchanged: record.unchanged,
        from_day: record.fromDay,
        to_day: record.toDay,
      });
      if (error) explain(error, "menyimpan impor");
    }
    for (let i = 0; i < plan.versions.length; i += 100) {
      const slice = plan.versions.slice(i, i + 100);
      const { error } = await this.sb.from("order_versions").insert(slice.map(versionRow));
      if (error) explain(error, "menyimpan versi");
      const lineRows = slice.flatMap((version) => version.lines.map((line, index) => ({
        id: line.id,
        version_id: version.id,
        line_no: index,
        sku: line.sku,
        product_name: line.productName,
        qty: line.qty,
        unit_price: line.unitPrice,
        sub_total: line.subTotal,
        unit_diskon: line.unitDiskon,
        revenue_per_unit: line.revenuePerUnit,
        missing_weight: line.missingWeight,
        bundle_key: line.bundleKey,
        unit_cogs: line.unitCogs,
        flags: line.flags,
      })));
      if (lineRows.length) {
        const inserted = await this.sb.from("order_lines").insert(lineRows);
        if (inserted.error) explain(inserted.error, "menyimpan baris");
      }
    }
    if (plan.changes.length) {
      const { error } = await this.sb.from("order_changes").insert(plan.changes.map((change) => ({
        id: change.id,
        no_pesanan: change.noPesanan,
        from_version_id: change.fromVersionId,
        to_version_id: change.toVersionId,
        field: change.field,
        kind: change.kind,
        old_value: change.oldValue,
        new_value: change.newValue,
      })));
      if (error) explain(error, "menyimpan riwayat perubahan");
    }
    for (const review of plan.reviews) {
      await this.sb.from("review_items").upsert({
        kind: review.kind,
        raw_key: review.rawKey,
        detail: review.detail,
        status: "open",
      }, { onConflict: "kind,raw_key" });
    }
  }

  async importCleanLines(lines: CleanLine[], filename: string, source: "clean" | "sample", by: string | null): Promise<ImportResult> {
    return this.importLines(lines, [], filename, source, by, { from: null, to: null });
  }

  async importRawLines(lines: CleanLine[], cancels: { noPesanan: string; status: string; day: string | null; tanggal: string | null }[], filename: string, by: string | null, range: { from: string | null; to: string | null }): Promise<ImportResult> {
    return this.importLines(lines, cancels, filename, "raw", by, range);
  }

  private async importLines(
    lines: CleanLine[],
    cancels: { noPesanan: string; status: string; day: string | null; tanggal: string | null }[],
    filename: string,
    source: ImportRecord["source"],
    by: string | null,
    range: { from: string | null; to: string | null },
  ): Promise<ImportResult> {
    const currentRows = await this.currentVersions();
    const current = new Map(currentRows.map((version) => [version.noPesanan, version]));
    const createdAt = new Date().toISOString();
    const importId = crypto.randomUUID();
    const plan = planImport(current, lines, { importId, source: source === "raw" ? "import_raw" : "import_clean", createdAt, createdBy: by });
    const cancelPlan = planCancels(current, cancels, { importId, createdAt, createdBy: by });
    const merged = {
      versions: [...plan.versions, ...cancelPlan.versions],
      changes: [...plan.changes, ...cancelPlan.changes],
      retireIds: [...plan.retireIds, ...cancelPlan.retireIds],
      reviews: [...plan.reviews, ...cancelPlan.reviews],
      unchanged: plan.unchanged,
    };
    const record: ImportRecord = {
      id: importId,
      filename,
      source,
      createdAt,
      createdBy: by,
      orderCount: new Set(lines.map((line) => line.noPesanan)).size,
      lineCount: lines.length,
      newVersions: merged.versions.length,
      unchanged: plan.unchanged,
      fromDay: range.from,
      toDay: range.to,
    };
    await this.writePlan(merged, record);
    return {
      importId,
      orders: record.orderCount,
      lines: lines.length,
      newVersions: merged.versions.length,
      unchanged: plan.unchanged,
      dropped: cancels.length,
      reviews: plan.reviews.length,
    };
  }

  private async oneCurrent(noPesanan: string): Promise<OrderVersion> {
    const data = await must(this.sb.from("order_versions").select("*").eq("no_pesanan", noPesanan).eq("is_current", true).maybeSingle(), "membaca pesanan");
    if (!data) throw new AppError("Pesanan tidak ditemukan.");
    const [version] = await this.hydrate([data as Row]);
    return version;
  }

  private async saveReplacement(previous: OrderVersion, next: OrderVersion) {
    await this.writePlan({
      versions: [next],
      changes: diffVersions(previous, next),
      retireIds: [previous.id],
      reviews: [],
      unchanged: 0,
    }, null);
    await this.sb.from("sync_states").update({ decision: null, decision_version_id: null, updated_at: next.createdAt }).eq("no_pesanan", next.noPesanan).eq("decision_version_id", previous.id);
  }

  async editLine(noPesanan: string, lineId: string, patch: { sku?: string; qty?: number; unitPrice?: number; city?: string }, by: string): Promise<void> {
    const previous = await this.oneCurrent(noPesanan);
    if (!previous.lines.some((line) => line.id === lineId)) throw new AppError("Baris tidak ditemukan.");
    const lines = applyLineEdit(previous, lineId, patch);
    const next: OrderVersion = {
      ...previous,
      id: crypto.randomUUID(),
      versionNo: previous.versionNo + 1,
      importId: null,
      source: "manual_edit",
      createdAt: new Date().toISOString(),
      createdBy: by,
      isCurrent: true,
      city: patch.city != null ? patch.city : previous.city,
      lines,
      qty: lines.reduce((sum, line) => sum + line.qty, 0),
      revenue: orderRevenue(lines),
      totalNilaiPesanan: lines.reduce((sum, line) => sum + (line.subTotal ?? 0), 0),
      totalDiskon: previous.totalDiskon,
    };
    if (!diffVersions(previous, next).length) throw new AppError("Tidak ada perubahan.");
    await this.saveReplacement(previous, next);
  }

  async deleteLine(noPesanan: string, lineId: string, by: string): Promise<void> {
    const previous = await this.oneCurrent(noPesanan);
    const kept = previous.lines.filter((line) => line.id !== lineId);
    if (kept.length === previous.lines.length) throw new AppError("Baris tidak ditemukan.");
    const lines = kept.length ? applyLineEdit({ ...previous, lines: kept }, kept[0].id, {}) : [];
    const next: OrderVersion = {
      ...previous,
      id: crypto.randomUUID(),
      versionNo: previous.versionNo + 1,
      importId: null,
      source: lines.length ? "manual_edit" : "manual_delete",
      createdAt: new Date().toISOString(),
      createdBy: by,
      isCurrent: true,
      lines,
      qty: lines.reduce((sum, line) => sum + line.qty, 0),
      revenue: orderRevenue(lines),
      totalNilaiPesanan: lines.reduce((sum, line) => sum + (line.subTotal ?? 0), 0),
      totalDiskon: previous.totalDiskon,
    };
    await this.saveReplacement(previous, next);
  }

  async syncReview(days: string[]): Promise<SyncReviewRow[]> {
    let query = this.sb.from("order_versions").select("*").eq("is_current", true);
    if (days.length) query = query.in("order_day", days);
    const data = await must(query, "membaca antrian sync");
    const versions = await this.hydrate((data ?? []) as Row[]);
    const nos = versions.map((version) => version.noPesanan);
    const states = nos.length
      ? await must(this.sb.from("sync_states").select("*").in("no_pesanan", nos), "membaca status sync")
      : [];
    const stateRows = (states ?? []) as Row[];
    const syncedIds = stateRows.map((row) => strOrNull(row.last_synced_version_id)).filter((id): id is string => Boolean(id));
    const missing = syncedIds.filter((id) => !versions.some((version) => version.id === id));
    const extra = missing.length ? await this.hydrate((await must(this.sb.from("order_versions").select("*").in("id", missing), "membaca versi tersinkron") ?? []) as Row[]) : [];
    const byId = new Map([...versions, ...extra].map((version) => [version.id, version]));
    const rows: SyncReviewRow[] = [];
    for (const version of versions) {
      const stateRow = stateRows.find((row) => str(row.no_pesanan) === version.noPesanan);
      const state = stateRow ? stateFrom(stateRow) : null;
      const synced = state?.lastSyncedVersionId ? byId.get(state.lastSyncedVersionId) ?? null : null;
      const row = reviewRow(version, synced, state);
      if (row) rows.push(row);
    }
    return rows.sort((a, b) => b.day.localeCompare(a.day) || a.noPesanan.localeCompare(b.noPesanan));
  }

  async prepareSync(nos: string[]): Promise<PreparedSync[]> {
    const review = await this.syncReview([]);
    const wanted = new Set(nos);
    const states = await must(this.sb.from("sync_states").select("*").in("no_pesanan", nos), "membaca status sync");
    return review.filter((row) => wanted.has(row.noPesanan)).map((row) => ({
      row,
      state: ((states ?? []) as Row[]).map(stateFrom).find((item) => item.noPesanan === row.noPesanan) ?? null,
    }));
  }

  async setDecision(noPesanan: string, decision: "confirmed" | "ignored", by: string): Promise<void> {
    void by;
    const version = await this.oneCurrent(noPesanan);
    const { error } = await this.sb.from("sync_states").upsert({
      no_pesanan: noPesanan,
      decision,
      decision_version_id: version.id,
      updated_at: new Date().toISOString(),
    });
    if (error) explain(error, "menyimpan konfirmasi");
  }

  async recordSync(by: string, items: SyncWrite[], note: string): Promise<SyncBatch> {
    const versions = items.length
      ? await this.hydrate((await must(this.sb.from("order_versions").select("*").in("id", items.map((item) => item.versionId)), "membaca versi sync") ?? []) as Row[])
      : [];
    const byId = new Map(versions.map((version) => [version.id, version]));
    const batchId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    let totalNilai = 0;
    let revenue = 0;
    for (const item of items) {
      if (item.status !== "berhasil") continue;
      const version = byId.get(item.versionId);
      totalNilai += version?.totalNilaiPesanan ?? 0;
      revenue += version?.revenue ?? 0;
    }
    const batch: SyncBatch = {
      id: batchId,
      createdAt,
      createdBy: by,
      orderCount: items.length,
      successCount: items.filter((item) => item.status === "berhasil").length,
      failCount: items.filter((item) => item.status === "gagal").length,
      totalNilai,
      revenue,
      note,
    };
    const inserted = await this.sb.from("sync_batches").insert({
      id: batch.id, created_at: batch.createdAt, created_by: by, order_count: batch.orderCount,
      success_count: batch.successCount, fail_count: batch.failCount, total_nilai: totalNilai, revenue, note,
    });
    if (inserted.error) explain(inserted.error, "menyimpan batch sync");
    if (items.length) {
      const rows = await this.sb.from("sync_batch_items").insert(items.map((item) => ({
        batch_id: batchId,
        no_pesanan: item.noPesanan,
        version_id: item.versionId,
        category: item.category,
        action: item.action,
        status: item.status,
        accurate_id: item.accurateId,
        accurate_number: item.accurateNumber,
        error: item.error,
        created_at: createdAt,
      })));
      if (rows.error) explain(rows.error, "menyimpan detail sync");
    }
    for (const item of items) {
      if (item.status !== "berhasil") continue;
      await this.sb.from("sync_states").upsert({
        no_pesanan: item.noPesanan,
        last_synced_version_id: item.versionId,
        accurate_id: item.action === "delete" ? null : item.accurateId,
        accurate_number: item.action === "delete" ? null : item.accurateNumber,
        last_sync_status: item.action === "delete" ? "void" : "tersinkron",
        decision: null,
        decision_version_id: null,
        updated_at: createdAt,
      });
    }
    return batch;
  }

  async syncHistory() {
    const batches = await must(this.sb.from("sync_batches").select("*").order("created_at", { ascending: false }), "membaca riwayat");
    const items = await must(this.sb.from("sync_batch_items").select("*").order("created_at", { ascending: false }).limit(2000), "membaca item sync");
    return {
      batches: ((batches ?? []) as Row[]).map(batchFrom),
      items: ((items ?? []) as Row[]).map(itemFrom),
    };
  }

  async orderHistory(noPesanan: string) {
    const versions = await this.hydrate((await must(this.sb.from("order_versions").select("*").eq("no_pesanan", noPesanan).order("version_no"), "membaca riwayat pesanan") ?? []) as Row[]);
    const changes = await must(this.sb.from("order_changes").select("*").eq("no_pesanan", noPesanan), "membaca perubahan");
    const items = await must(this.sb.from("sync_batch_items").select("*").eq("no_pesanan", noPesanan), "membaca sync pesanan");
    return {
      versions,
      changes: ((changes ?? []) as Row[]).map(changeFrom),
      items: ((items ?? []) as Row[]).map(itemFrom),
    };
  }

  async listChannelMaps(): Promise<ChannelMapRow[]> {
    const data = await must(this.sb.from("channel_store_map").select("*").order("channel_raw"), "membaca mapping channel");
    return ((data ?? []) as Row[]).map((row) => ({
      id: str(row.id), channelRaw: str(row.channel_raw), storeRaw: str(row.store_raw),
      channel: str(row.channel), store: str(row.store_name), needsReview: Boolean(row.needs_review),
    }));
  }
  async saveChannelMap(row: Omit<ChannelMapRow, "id"> & { id?: string }) {
    const { error } = await this.sb.from("channel_store_map").upsert({
      id: row.id, channel_raw: row.channelRaw, store_raw: row.storeRaw, channel: row.channel, store_name: row.store, needs_review: row.needsReview,
    });
    if (error) explain(error, "menyimpan mapping channel");
  }
  async deleteChannelMap(id: string) {
    const { error } = await this.sb.from("channel_store_map").delete().eq("id", id);
    if (error) explain(error, "menghapus mapping channel");
  }
  async listProvinceMaps(): Promise<ProvinceMapRow[]> {
    const data = await must(this.sb.from("province_map").select("*").order("raw"), "membaca mapping provinsi");
    return ((data ?? []) as Row[]).map((row) => ({ id: str(row.id), raw: str(row.raw), official: str(row.official), needsReview: Boolean(row.needs_review) }));
  }
  async saveProvinceMap(row: Omit<ProvinceMapRow, "id"> & { id?: string }) {
    const { error } = await this.sb.from("province_map").upsert({ id: row.id, raw: row.raw, official: row.official, needs_review: row.needsReview });
    if (error) explain(error, "menyimpan mapping provinsi");
  }
  async listCityMaps(): Promise<CityMapRow[]> {
    const data = await must(this.sb.from("city_map").select("*").order("province_raw"), "membaca mapping kota");
    return ((data ?? []) as Row[]).map((row) => ({
      id: str(row.id), provinceRaw: str(row.province_raw), cityRaw: str(row.city_raw), official: str(row.official), needsReview: Boolean(row.needs_review),
    }));
  }
  async saveCityMap(row: Omit<CityMapRow, "id"> & { id?: string }) {
    const { error } = await this.sb.from("city_map").upsert({
      id: row.id, province_raw: row.provinceRaw, city_raw: row.cityRaw, official: row.official, needs_review: row.needsReview,
    });
    if (error) explain(error, "menyimpan mapping kota");
  }
  async listWeights(): Promise<BundleWeight[]> {
    const data = await must(this.sb.from("bundle_weights").select("*").order("bundle_key"), "membaca bobot");
    return ((data ?? []) as Row[]).map((row) => ({ id: str(row.id), bundleKey: str(row.bundle_key), bobot: num(row.bobot), updatedAt: str(row.updated_at) }));
  }
  async upsertWeights(rows: { bundleKey: string; bobot: number }[], replace: boolean) {
    if (replace) {
      const { error } = await this.sb.from("bundle_weights").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) explain(error, "mengosongkan bobot");
    }
    if (!rows.length) return 0;
    const { error } = await this.sb.from("bundle_weights").upsert(rows.map((row) => ({ bundle_key: row.bundleKey.trim(), bobot: row.bobot, updated_at: new Date().toISOString() })), { onConflict: "bundle_key" });
    if (error) explain(error, "menyimpan bobot");
    return rows.length;
  }
  async updateWeight(id: string, patch: { bundleKey?: string; bobot?: number }) {
    const update: Row = { updated_at: new Date().toISOString() };
    if (patch.bundleKey) update.bundle_key = patch.bundleKey.trim();
    if (patch.bobot != null) update.bobot = patch.bobot;
    const data = await must(this.sb.from("bundle_weights").update(update).eq("id", id).select("*").single(), "mengubah bobot");
    const row = data as Row;
    return { id: str(row.id), bundleKey: str(row.bundle_key), bobot: num(row.bobot), updatedAt: str(row.updated_at) };
  }
  async deleteWeight(id: string) {
    const { error } = await this.sb.from("bundle_weights").delete().eq("id", id);
    if (error) explain(error, "menghapus bobot");
  }
  async listReviews(): Promise<ReviewItem[]> {
    const data = await must(this.sb.from("review_items").select("*").order("created_at", { ascending: false }), "membaca review");
    return ((data ?? []) as Row[]).map((row) => ({
      id: str(row.id),
      kind: str(row.kind) as ReviewItem["kind"],
      rawKey: str(row.raw_key),
      detail: (row.detail && typeof row.detail === "object" ? row.detail : {}) as Record<string, string>,
      status: str(row.status) === "resolved" ? "resolved" : "open",
    }));
  }
  async resolveReview(id: string) {
    const { error } = await this.sb.from("review_items").update({ status: "resolved" }).eq("id", id);
    if (error) explain(error, "menutup review");
  }
  async getSettings(): Promise<AppSettings> {
    const data = await must(this.sb.from("app_settings").select("data").eq("id", 1).maybeSingle(), "membaca pengaturan");
    return sanitizeSettings((data as Row | null)?.data ?? null);
  }
  async saveSettings(settings: AppSettings) {
    const clean = sanitizeSettings(settings);
    const { error } = await this.sb.from("app_settings").upsert({ id: 1, data: clean, updated_at: new Date().toISOString() });
    if (error) explain(error, "menyimpan pengaturan");
    return clean;
  }
  async getTokens(): Promise<AccurateTokens | null> {
    const data = await must(this.sb.from("accurate_tokens").select("*").eq("id", 1).maybeSingle(), "membaca token");
    const row = data as Row | null;
    if (!row?.access_token) return null;
    return {
      accessToken: str(row.access_token),
      refreshToken: strOrNull(row.refresh_token),
      expiresAt: strOrNull(row.expires_at),
      scope: strOrNull(row.scope),
      userEmail: strOrNull(row.user_email),
      updatedAt: str(row.updated_at),
    };
  }
  async saveTokens(tokens: AccurateTokens | null) {
    if (!tokens) {
      const { error } = await this.sb.from("accurate_tokens").delete().eq("id", 1);
      if (error) explain(error, "memutus Accurate");
      return;
    }
    const { error } = await this.sb.from("accurate_tokens").upsert({
      id: 1,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt,
      scope: tokens.scope,
      user_email: tokens.userEmail,
      updated_at: tokens.updatedAt,
    });
    if (error) explain(error, "menyimpan token Accurate");
  }
}

function numberGroup<T extends { gross: number; net: number; qty: number; orders: number }>(row: T): T {
  return { ...row, gross: Number(row.gross), net: Number(row.net), qty: Number(row.qty), orders: Number(row.orders) };
}

function stateFrom(row: Row): SyncState {
  const decision = strOrNull(row.decision);
  return {
    noPesanan: str(row.no_pesanan),
    lastSyncedVersionId: strOrNull(row.last_synced_version_id),
    accurateId: strOrNull(row.accurate_id),
    accurateNumber: strOrNull(row.accurate_number),
    lastSyncStatus: (strOrNull(row.last_sync_status) as SyncState["lastSyncStatus"]) ?? null,
    decision: decision === "confirmed" || decision === "ignored" ? decision : null,
    decisionVersionId: strOrNull(row.decision_version_id),
    updatedAt: str(row.updated_at),
  };
}

function batchFrom(row: Row): SyncBatch {
  return {
    id: str(row.id),
    createdAt: str(row.created_at),
    createdBy: strOrNull(row.created_by),
    orderCount: num(row.order_count),
    successCount: num(row.success_count),
    failCount: num(row.fail_count),
    totalNilai: num(row.total_nilai),
    revenue: num(row.revenue),
    note: str(row.note),
  };
}

function itemFrom(row: Row): SyncBatchItem {
  return {
    id: str(row.id),
    batchId: str(row.batch_id),
    noPesanan: str(row.no_pesanan),
    versionId: str(row.version_id),
    category: str(row.category) as SyncBatchItem["category"],
    action: str(row.action) as SyncBatchItem["action"],
    status: str(row.status) === "gagal" ? "gagal" : "berhasil",
    accurateId: strOrNull(row.accurate_id),
    accurateNumber: strOrNull(row.accurate_number),
    error: strOrNull(row.error),
    createdAt: str(row.created_at),
  };
}

function changeFrom(row: Row): FieldChange {
  return {
    id: str(row.id),
    noPesanan: str(row.no_pesanan),
    fromVersionId: strOrNull(row.from_version_id),
    toVersionId: str(row.to_version_id),
    field: str(row.field),
    kind: str(row.kind) as FieldChange["kind"],
    oldValue: strOrNull(row.old_value),
    newValue: strOrNull(row.new_value),
  };
}

function pageVersions(versions: OrderVersion[], query: OrderQuery): OrderPage {
  const q = query.q.trim().toLowerCase();
  const rows = versions
    .filter((version) => version.isCurrent && version.source !== "cancel" && version.source !== "manual_delete")
    .flatMap((version) => version.lines.map((line) => ({ version, line })))
    .filter(({ version, line }) => {
      if (query.day && version.day !== query.day) return false;
      if (!q) return true;
      return [version.noPesanan, line.sku, line.productName, version.customerName, version.storeName, version.city, version.channel].join(" ").toLowerCase().includes(q);
    });
  const pageSize = query.pageSize || 30;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(query.page, 0), pages - 1);
  return {
    total: rows.length,
    orders: new Set(rows.map((row) => row.version.noPesanan)).size,
    page,
    pages,
    rows: rows.slice(page * pageSize, page * pageSize + pageSize).map(({ version, line }) => ({
      lineId: line.id,
      versionId: version.id,
      noPesanan: version.noPesanan,
      tanggal: version.tanggal,
      day: version.day,
      channel: version.channel,
      storeName: version.storeName,
      sku: line.sku,
      productName: line.productName,
      qty: line.qty,
      unitPrice: line.unitPrice,
      subTotal: line.subTotal,
      totalNilaiPesanan: version.totalNilaiPesanan,
      totalDiskon: version.totalDiskon,
      unitDiskon: line.unitDiskon,
      revenuePerUnit: line.revenuePerUnit,
      customerName: version.customerName,
      customerCode: version.customerCode,
      province: version.province,
      city: version.city,
      kurir: version.kurir,
      status: version.status,
      flags: line.flags,
    })),
  };
}
