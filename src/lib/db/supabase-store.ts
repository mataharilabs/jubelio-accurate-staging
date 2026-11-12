import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CleanLine } from "@/lib/cleanup/rapikan";
import { sanitizeSettings } from "@/lib/db/defaults";
import { bucketLabel } from "@/lib/domain/aggregate";
import { applyLineEdit, diffVersions, orderRevenue } from "@/lib/domain/orders";
import { buildReturnVersions, canSoftDeleteOrder } from "@/lib/domain/phase3";
import { planCancels, planImport } from "@/lib/domain/plan";
import { reviewRow } from "@/lib/domain/review-rows";
import type { DataStore, PreparedSync, SyncWrite } from "@/lib/db/store";
import type {
  AccurateTokens,
  AppMeta,
  AppSettings,
  BundleComponent,
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
import { commitWithRollback, eachPage, pickLatestRows, supabaseFetch, type RollbackStep } from "@/lib/db/supabase-paging";
import { shouldPersistImport } from "@/lib/jubelio/schedule";
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
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: supabaseFetch },
  });
}

function explainBundle(error: { message?: string; code?: string } | null, action: string): never {
  const missing = error?.code === "42P01" || error?.code === "PGRST202" || error?.code === "PGRST205" || /bundle_components|ordered_skus|save_bundle_components|does not exist|schema cache/i.test(error?.message ?? "");
  if (missing) throw new AppError("Jalankan supabase/migrations/0011_product_names_bundle_weights.sql di SQL Editor.");
  throw new AppError(error?.message || `Gagal ${action}.`);
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

/** Chunked `.in` filter. One request past 1000 matches is truncated, and a long `in.(...)` exceeds the URL limit. */
async function selectIn(sb: SupabaseClient, table: string, column: string, values: string[], action: string): Promise<Row[]> {
  const unique = [...new Set(values.filter(Boolean))];
  const rows: Row[] = [];
  for (let i = 0; i < unique.length; i += 80) {
    const slice = unique.slice(i, i + 80);
    const { data, error } = await sb.from(table).select("*").in(column, slice);
    if (error) explain(error, action);
    rows.push(...((data ?? []) as Row[]));
  }
  return rows;
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
    dataStatus: row.data_status === "deleted" ? "deleted" : "active",
    contentUpdatedAt: row.content_updated_at ? String(row.content_updated_at) : null,
    returnCase: row.return_case === 1 || row.return_case === 2 || row.return_case === 3 ? row.return_case : null,
    parentNoPesanan: strOrNull(row.parent_no_pesanan),
    lossSibling: Boolean(row.loss_sibling),
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
    data_status: version.dataStatus ?? "active",
    content_updated_at: version.contentUpdatedAt ?? version.createdAt,
    return_case: version.returnCase ?? null,
    parent_no_pesanan: version.parentNoPesanan ?? null,
    loss_sibling: Boolean(version.lossSibling),
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
      const data = await eachPage(async (from, to) => {
        const { data: page, error } = await this.sb.from("order_lines").select("*").in("version_id", slice).order("id").range(from, to);
        if (error) explain(error, "membaca baris");
        return (page ?? []) as Row[];
      });
      const grouped = new Map<string, Row[]>();
      for (const row of data) {
        const id = str(row.version_id);
        const list = grouped.get(id) ?? [];
        list.push(row);
        grouped.set(id, list);
      }
      for (const [id, rows] of grouped) {
        rows.sort((a, b) => num(a.line_no) - num(b.line_no));
        const list = map.get(id) ?? [];
        list.push(...rows.map(lineFrom));
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
    const data = await eachPage(async (from, to) => {
      const { data: page, error } = await this.sb.from("order_versions").select("*").eq("is_current", true).order("id").range(from, to);
      if (error) explain(error, "membaca versi");
      return (page ?? []) as Row[];
    });
    return this.hydrate(data);
  }

  /** Latest version of each order, paging past PostgREST's 1000-row cap. Includes a non-current row when a failed import cleared is_current. */
  private async latestForOrders(orderNos: string[]): Promise<Map<string, OrderVersion>> {
    const unique = [...new Set(orderNos.filter(Boolean))];
    const headers: Row[] = [];
    for (let i = 0; i < unique.length; i += 80) {
      const slice = unique.slice(i, i + 80);
      const page = await eachPage(async (from, to) => {
        const { data, error } = await this.sb.from("order_versions").select("*").in("no_pesanan", slice).order("id").range(from, to);
        if (error) explain(error, "membaca versi pesanan");
        return (data ?? []) as Row[];
      });
      headers.push(...page);
    }
    const versions = await this.hydrate(pickLatestRows(headers));
    return new Map(versions.map((version) => [version.noPesanan, version]));
  }

  async meta(): Promise<AppMeta> {
    const [imports, active, reviews, lines, tokens] = await Promise.all([
      this.sb.from("imports").select("created_at").order("created_at", { ascending: false }).limit(1),
      this.sb.from("order_versions").select("id", { count: "exact", head: true }).eq("is_current", true).neq("source", "cancel").neq("source", "manual_delete"),
      this.sb.from("review_items").select("id", { count: "exact", head: true }).eq("status", "open"),
      this.sb.from("v_sales_current").select("line_id", { count: "exact", head: true }),
      this.getTokens(),
    ]);
    if (imports.error) explain(imports.error, "membaca impor");
    if (active.error) explain(active.error, "menghitung pesanan");
    if (reviews.error) explain(reviews.error, "menghitung review");
    return {
      mode: "supabase",
      ephemeral: false,
      lastImportAt: imports.data?.[0] ? str((imports.data[0] as Row).created_at) : null,
      orderCount: active.count ?? 0,
      lineCount: lines.count ?? 0,
      openReviews: reviews.count ?? 0,
      accurateConnected: Boolean(tokens?.accessToken),
      accurateConfigured: accurateConfigured(),
      accurateUser: tokens?.userEmail ?? null,
      ppnReportDate: (await this.getSettings()).ppnReportDate || null,
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
        brands: query.brands ?? [],
        categories: query.categories ?? [],
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
        hpp: Number(raw.kpis.hpp ?? 0),
        fee: Number(raw.kpis.fee ?? 0),
        marketing: Number(raw.kpis.marketing ?? 0),
        profit: Number(raw.kpis.profit ?? raw.kpis.net ?? 0),
        missingSkus: Number(raw.kpis.missingSkus ?? 0),
        missingSkuSample: Array.isArray(raw.kpis.missingSkuSample) ? raw.kpis.missingSkuSample.map(String) : [],
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
        gross: Number(row.gross ?? 0),
        hpp: Number(row.hpp ?? 0),
        profit: Number(row.profit ?? row.net ?? 0),
        qty: Number(row.qty),
        orders: Number(row.orders),
        share: net ? Number(row.net) / net : 0,
      })),
      cities: (raw.cities ?? []).map((row) => ({
        key: row.key,
        net: Number(row.net),
        gross: Number(row.gross ?? 0),
        hpp: Number(row.hpp ?? 0),
        profit: Number(row.profit ?? row.net ?? 0),
        qty: Number(row.qty),
        orders: Number(row.orders),
        share: net ? Number(row.net) / net : 0,
      })),
      brands: (raw.brands ?? []).map(numberGroup),
      categories: (raw.categories ?? []).map(numberGroup),
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
    const { data, error } = await this.sb.rpc("orders_page", { p: {
      day: query.day,
      from: query.from ?? null,
      to: query.to ?? null,
      statuses: query.statuses ?? [],
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
      dataStatus: query.dataStatus ?? "active",
      channels: query.channels ?? [],
      stores: query.stores ?? [],
      sync: query.sync ?? "",
    } });
    if (error) {
      const text = error.message ?? "";
      if (error.code === "PGRST202" || /orders_page|does not exist|schema cache/i.test(text)) {
        throw new AppError("Jalankan supabase/migrations/0005_products.sql di SQL Editor.");
      }
      explain(error, "membaca pesanan");
    }
    const raw = (data ?? {}) as OrderPage;
    return {
      total: Number(raw.total ?? 0),
      orders: Number(raw.orders ?? 0),
      page: Number(raw.page ?? 0),
      pages: Number(raw.pages ?? 1),
      rows: (raw.rows ?? []).map((row) => ({ ...row, flags: row.flags ?? [], hpp: row.hpp == null ? null : Number(row.hpp), grossProfit: row.grossProfit == null ? null : Number(row.grossProfit) })),
    };
  }

  private async writePlan(plan: ReturnType<typeof planImport>, record: ImportRecord | null) {
    const steps: RollbackStep[] = [];
    for (let i = 0; i < plan.retireIds.length; i += 200) {
      const ids = plan.retireIds.slice(i, i + 200);
      steps.push({
        run: async () => {
          const { error } = await this.sb.from("order_versions").update({ is_current: false }).in("id", ids);
          if (error) explain(error, "menutup versi lama");
        },
        undo: async () => {
          const { error } = await this.sb.from("order_versions").update({ is_current: true }).in("id", ids);
          if (error) explain(error, "memulihkan versi lama");
        },
      });
    }
    if (record) {
      steps.push({
        run: async () => {
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
        },
        undo: async () => {
          const { error } = await this.sb.from("imports").delete().eq("id", record.id);
          if (error) explain(error, "membatalkan catatan impor");
        },
      });
    }
    for (let i = 0; i < plan.versions.length; i += 100) {
      const slice = plan.versions.slice(i, i + 100);
      const ids = slice.map((version) => version.id);
      steps.push({
        run: async () => {
          const { error } = await this.sb.from("order_versions").insert(slice.map(versionRow));
          if (error) explain(error, "menyimpan versi");
        },
        undo: async () => {
          const { error } = await this.sb.from("order_versions").delete().in("id", ids);
          if (error) explain(error, "membatalkan versi baru");
        },
      });
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
        steps.push({
          run: async () => {
            const inserted = await this.sb.from("order_lines").insert(lineRows);
            if (inserted.error) explain(inserted.error, "menyimpan baris");
          },
          undo: async () => {},
        });
      }
    }
    if (plan.changes.length) {
      const ids = plan.changes.map((change) => change.id);
      steps.push({
        run: async () => {
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
        },
        undo: async () => {
          const { error } = await this.sb.from("order_changes").delete().in("id", ids);
          if (error) explain(error, "membatalkan riwayat perubahan");
        },
      });
    }
    if (plan.reviews.length) {
      steps.push({
        run: async () => {
          const { error } = await this.sb.from("review_items").upsert(plan.reviews.map((review) => ({
            kind: review.kind,
            raw_key: review.rawKey,
            detail: review.detail,
            status: "open",
          })), { onConflict: "kind,raw_key" });
          if (error) explain(error, "menyimpan antrean review");
        },
        undo: async () => {},
      });
    }
    await commitWithRollback(steps);
  }

  async importCleanLines(lines: CleanLine[], filename: string, source: "clean" | "sample", by: string | null, duplicate: "overwrite" | "skip" = "overwrite"): Promise<ImportResult> {
    return this.importLines(lines, [], filename, source, by, { from: null, to: null }, duplicate);
  }

  async importRawLines(lines: CleanLine[], cancels: { noPesanan: string; status: string; day: string | null; tanggal: string | null }[], filename: string, by: string | null, range: { from: string | null; to: string | null }, source: "raw" | "api" = "raw", duplicate: "overwrite" | "skip" = "overwrite"): Promise<ImportResult> {
    return this.importLines(lines, cancels, filename, source, by, range, duplicate);
  }

  private async importLines(
    lines: CleanLine[],
    cancels: { noPesanan: string; status: string; day: string | null; tanggal: string | null }[],
    filename: string,
    source: ImportRecord["source"],
    by: string | null,
    range: { from: string | null; to: string | null },
    duplicate: "overwrite" | "skip" = "overwrite",
  ): Promise<ImportResult> {
    const current = await this.latestForOrders([
      ...lines.map((line) => line.noPesanan),
      ...cancels.map((cancel) => cancel.noPesanan),
    ]);
    const createdAt = new Date().toISOString();
    const importId = crypto.randomUUID();
    const plan = planImport(current, lines, { importId, source: source === "clean" || source === "sample" ? "import_clean" : "import_raw", createdAt, createdBy: by, duplicate, protectManual: source === "api" });
    const keptCancels = source === "api" ? cancels.filter((cancel) => current.get(cancel.noPesanan)?.source !== "manual") : cancels;
    const cancelPlan = planCancels(current, keptCancels, { importId, createdAt, createdBy: by });
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
    await this.writePlan(merged, shouldPersistImport(merged.versions.length) ? record : null);
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
    const { error } = await this.sb.from("sync_states").update({ decision: null, decision_version_id: null, updated_at: next.createdAt }).eq("no_pesanan", next.noPesanan).eq("decision_version_id", previous.id);
    if (error) explain(error, "mengosongkan konfirmasi sync");
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
      contentUpdatedAt: new Date().toISOString(),
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
    const data = await eachPage(async (from, to) => {
      let query = this.sb.from("order_versions").select("*").eq("is_current", true);
      if (days.length) query = query.in("order_day", days);
      const { data: page, error } = await query.order("id").range(from, to);
      if (error) explain(error, "membaca antrian sync");
      return (page ?? []) as Row[];
    });
    const versions = await this.hydrate(data);
    const nos = versions.map((version) => version.noPesanan);
    const stateRows = await selectIn(this.sb, "sync_states", "no_pesanan", nos, "membaca status sync");
    const syncedIds = stateRows.map((row) => strOrNull(row.last_synced_version_id)).filter((id): id is string => Boolean(id));
    const missing = syncedIds.filter((id) => !versions.some((version) => version.id === id));
    const extra = missing.length ? await this.hydrate(await selectIn(this.sb, "order_versions", "id", missing, "membaca versi tersinkron")) : [];
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
    const states = await selectIn(this.sb, "sync_states", "no_pesanan", nos, "membaca status sync");
    return review.filter((row) => wanted.has(row.noPesanan)).map((row) => ({
      row,
      state: states.map(stateFrom).find((item) => item.noPesanan === row.noPesanan) ?? null,
    }));
  }

  async setDecision(noPesanan: string, decision: "confirmed" | "ignored", by: string): Promise<void> {
    void by;
    const version = await this.oneCurrent(noPesanan);
    const now = new Date().toISOString();
    const payload: Row = {
      no_pesanan: noPesanan,
      decision,
      decision_version_id: version.id,
      updated_at: now,
    };
    if (decision === "ignored") payload.synced_at = now;
    const { error } = await this.sb.from("sync_states").upsert(payload);
    if (error) explain(error, "menyimpan konfirmasi");
    if (decision === "ignored") await this.logSync({ actor: by, action: "ignore", noPesanan, note: "Abaikan sync" });
  }

  async recordSync(by: string, items: SyncWrite[], note: string): Promise<SyncBatch> {
    const versions = items.length
      ? await this.hydrate(await selectIn(this.sb, "order_versions", "id", items.map((item) => item.versionId), "membaca versi sync"))
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
      const { error } = await this.sb.from("sync_states").upsert({
        no_pesanan: item.noPesanan,
        last_synced_version_id: item.versionId,
        accurate_id: item.action === "delete" ? null : item.accurateId,
        accurate_number: item.action === "delete" ? null : item.accurateNumber,
        last_sync_status: item.action === "delete" ? "void" : "tersinkron",
        decision: null,
        decision_version_id: null,
        updated_at: createdAt,
        synced_at: createdAt,
      });
      if (error) explain(error, "menyimpan status sync");
      await this.logSync({ actor: by, action: "sync", noPesanan: item.noPesanan, note });
    }
    return batch;
  }

  async logSync(entry: { actor: string | null; action: "sync" | "ignore" | "blocked"; noPesanan: string; note?: string }): Promise<void> {
    const { error } = await this.sb.from("sync_log").insert({
      actor: entry.actor,
      action: entry.action,
      no_pesanan: entry.noPesanan,
      note: entry.note ?? "",
    });
    if (error && /sync_log|schema cache|does not exist/i.test(error.message ?? "")) return;
    if (error) explain(error, "mencatat log sync");
  }

  async listSyncLog(): Promise<{ at: string; actor: string | null; action: string; noPesanan: string; note: string }[]> {
    const { data, error } = await this.sb.from("sync_log").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) return [];
    return ((data ?? []) as Row[]).map((row) => ({
      at: str(row.created_at),
      actor: strOrNull(row.actor),
      action: str(row.action),
      noPesanan: str(row.no_pesanan),
      note: str(row.note),
    }));
  }

  async setDataStatus(noPesanan: string, dataStatus: "active" | "deleted"): Promise<void> {
    const current = await this.oneCurrent(noPesanan);
    if (dataStatus === "deleted") {
      const state = await must(this.sb.from("sync_states").select("*").eq("no_pesanan", noPesanan).maybeSingle(), "membaca status sync");
      const row = state as Row | null;
      const synced = Boolean(row && (row.last_sync_status === "tersinkron" || str(row.accurate_id)));
      const gate = canSoftDeleteOrder({ synced });
      if (!gate.ok) throw new AppError(gate.reason ?? "Tidak bisa dihapus.");
    }
    const { error } = await this.sb.from("order_versions").update({ data_status: dataStatus }).eq("id", current.id);
    if (error) explain(error, "mengubah status data");
  }

  async applyReturn(noPesanan: string, input: { status: string; returnCase: 1 | 2 | 3 | null; lost: { sku: string; qty: number }[] }, by: string): Promise<void> {
    const previous = await this.oneCurrent(noPesanan);
    const siblingNo = `${previous.noPesanan}-R`;
    const siblingRow = await this.sb.from("order_versions").select("*").eq("no_pesanan", siblingNo).eq("is_current", true).maybeSingle();
    const sibling = siblingRow.data ? (await this.hydrate([siblingRow.data as Row]))[0] : null;
    const built = buildReturnVersions(previous, sibling, { ...input, by, now: new Date().toISOString() });
    if (built.error) throw new AppError(built.error);
    const [original, nextSibling] = built.versions;
    await this.saveReplacement(previous, original);
    if (nextSibling && sibling) await this.saveReplacement(sibling, nextSibling);
    else if (nextSibling) {
      await this.writePlan({ versions: [nextSibling], changes: [], retireIds: [], reviews: [], unchanged: 0 }, null);
    }
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
      mappedAt: optionalTime(row, "mapped_at"),
    }));
  }
  async saveChannelMap(row: Omit<ChannelMapRow, "id"> & { id?: string }) {
    const { error } = await this.sb.from("channel_store_map").upsert({
      id: row.id, channel_raw: row.channelRaw, store_raw: row.storeRaw, channel: row.channel, store_name: row.store, needs_review: row.needsReview,
      mapped_at: row.channel.trim() && row.store.trim() && !row.needsReview ? new Date().toISOString() : null,
    });
    if (error) explain(error, "menyimpan mapping channel");
  }
  async deleteChannelMap(id: string) {
    const { error } = await this.sb.from("channel_store_map").delete().eq("id", id);
    if (error) explain(error, "menghapus mapping channel");
  }
  async listProvinceMaps(): Promise<ProvinceMapRow[]> {
    const data = await must(this.sb.from("province_map").select("*").order("raw"), "membaca mapping provinsi");
    return ((data ?? []) as Row[]).map((row) => ({ id: str(row.id), raw: str(row.raw), official: str(row.official), needsReview: Boolean(row.needs_review), mappedAt: optionalTime(row, "mapped_at") }));
  }
  async saveProvinceMap(row: Omit<ProvinceMapRow, "id"> & { id?: string }) {
    const payload = { raw: row.raw, official: row.official, needs_review: row.needsReview, mapped_at: row.official.trim() && !row.needsReview ? new Date().toISOString() : null };
    const query = row.id
      ? this.sb.from("province_map").upsert({ ...payload, id: row.id })
      : this.sb.from("province_map").upsert(payload, { onConflict: "raw" });
    const { error } = await query;
    if (error) explain(error, "menyimpan mapping provinsi");
  }
  async listCityMaps(): Promise<CityMapRow[]> {
    const data = await must(this.sb.from("city_map").select("*").order("province_raw"), "membaca mapping kota");
    return ((data ?? []) as Row[]).map((row) => ({
      id: str(row.id), provinceRaw: str(row.province_raw), cityRaw: str(row.city_raw), official: str(row.official), needsReview: Boolean(row.needs_review), mappedAt: optionalTime(row, "mapped_at"),
    }));
  }
  async saveCityMap(row: Omit<CityMapRow, "id"> & { id?: string }) {
    const payload = { province_raw: row.provinceRaw, city_raw: row.cityRaw, official: row.official, needs_review: row.needsReview, mapped_at: row.official.trim() && !row.needsReview ? new Date().toISOString() : null };
    const query = row.id
      ? this.sb.from("city_map").upsert({ ...payload, id: row.id })
      : this.sb.from("city_map").upsert(payload, { onConflict: "province_raw,city_raw" });
    const { error } = await query;
    if (error) explain(error, "menyimpan mapping kota");
  }
  async listWeights(): Promise<BundleWeight[]> {
    const data = await must(this.sb.from("bundle_weights").select("*").order("bundle_key"), "membaca bobot");
    return ((data ?? []) as Row[]).map((row) => ({ id: str(row.id), bundleKey: str(row.bundle_key), bobot: num(row.bobot), updatedAt: str(row.updated_at), confirmedAt: optionalTime(row, "confirmed_at") }));
  }
  async upsertWeights(rows: { bundleKey: string; bobot: number }[], replace: boolean) {
    if (replace) {
      const { error } = await this.sb.from("bundle_weights").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) explain(error, "mengosongkan bobot");
    }
    if (!rows.length) return 0;
    const now = new Date().toISOString();
    const { error } = await this.sb.from("bundle_weights").upsert(rows.map((row) => ({ bundle_key: row.bundleKey.trim(), bobot: row.bobot, updated_at: now, confirmed_at: now })), { onConflict: "bundle_key" });
    if (error) explain(error, "menyimpan bobot");
    return rows.length;
  }
  async updateWeight(id: string, patch: { bundleKey?: string; bobot?: number }) {
    const now = new Date().toISOString();
    const update: Row = { updated_at: now, confirmed_at: now };
    if (patch.bundleKey) update.bundle_key = patch.bundleKey.trim();
    if (patch.bobot != null) update.bobot = patch.bobot;
    const data = await must(this.sb.from("bundle_weights").update(update).eq("id", id).select("*").single(), "mengubah bobot");
    const row = data as Row;
    return { id: str(row.id), bundleKey: str(row.bundle_key), bobot: num(row.bobot), updatedAt: str(row.updated_at), confirmedAt: optionalTime(row, "confirmed_at") ?? now };
  }
  async deleteWeight(id: string) {
    const { error } = await this.sb.from("bundle_weights").delete().eq("id", id);
    if (error) explain(error, "menghapus bobot");
  }
  async listBundleComponents(): Promise<BundleComponent[]> {
    const { data, error } = await this.sb.from("bundle_components").select("*").order("bundle_sku").order("position");
    if (error) explainBundle(error, "membaca komponen paket");
    return ((data ?? []) as Row[]).map((row) => ({
      id: str(row.id),
      bundleSku: str(row.bundle_sku),
      sku: str(row.component_sku),
      qty: num(row.qty),
      weightPct: num(row.weight_pct),
      position: num(row.position),
      legacyKey: strOrNull(row.legacy_key),
      updatedAt: str(row.updated_at),
      confirmedAt: optionalTime(row, "confirmed_at"),
    }));
  }
  async saveBundle(bundleSku: string, components: { sku: string; qty: number; weightPct: number }[]) {
    const { error } = await this.sb.rpc("save_bundle_components", { p: { bundleSku: bundleSku.trim(), components } });
    if (error) explainBundle(error, "menyimpan komponen paket");
  }
  async deleteBundle(bundleSku: string) {
    const sku = bundleSku.trim();
    const existing = (await this.listBundleComponents()).filter((row) => row.bundleSku === sku);
    const keys = [sku, ...existing.flatMap((row) => [row.legacyKey, `${sku}-${row.sku}`].filter((key): key is string => Boolean(key)))];
    const { error } = await this.sb.from("bundle_components").delete().eq("bundle_sku", sku);
    if (error) explainBundle(error, "menghapus paket");
    const { error: weights } = await this.sb.from("bundle_weights").delete().in("bundle_key", [...new Set(keys)]);
    if (weights) explain(weights, "menghapus bobot lama");
  }
  async clearBundleComponents() {
    const { error } = await this.sb.from("bundle_components").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) explainBundle(error, "mengosongkan komponen paket");
  }
  async listOrderedSkus() {
    const { data, error } = await this.sb.rpc("ordered_skus");
    if (error) explainBundle(error, "membaca SKU pesanan");
    if (!Array.isArray(data)) return [];
    return data.flatMap((row) => {
      if (typeof row === "string") return row ? [row] : [];
      if (row && typeof row === "object" && "sku" in row) {
        const sku = String((row as { sku?: unknown }).sku ?? "");
        return sku ? [sku] : [];
      }
      return [];
    });
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

  async createManualOrder(version: OrderVersion): Promise<void> {
    const data = await must(this.sb.from("order_versions").select("id, version_no, is_current").eq("no_pesanan", version.noPesanan), "memeriksa nomor pesanan");
    const rows = (data ?? []) as Row[];
    if (rows.some((row) => Boolean(row.is_current))) throw new AppError("Nomor pesanan sudah ada.");
    const versionNo = rows.reduce((max, row) => Math.max(max, Number(row.version_no) || 0), 0) + 1;
    try {
      await this.writePlan({ versions: [{ ...version, versionNo }], changes: [], retireIds: [], reviews: [], unchanged: 0 }, null);
    } catch (error) {
      if (error instanceof AppError && /source_check|check constraint|violates check/i.test(error.message)) {
        throw new AppError("Jalankan supabase/migrations/0010_manual_master.sql di SQL Editor sebelum menambah pesanan manual.");
      }
      throw error;
    }
  }
}

function numberGroup<T extends { gross: number; net: number; qty: number; orders: number; hpp?: number; profit?: number }>(row: T): T {
  return {
    ...row,
    gross: Number(row.gross),
    net: Number(row.net),
    qty: Number(row.qty),
    orders: Number(row.orders),
    hpp: Number(row.hpp ?? 0),
    profit: Number(row.profit ?? row.net ?? 0),
  };
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
    syncedAt: optionalTime(row, "synced_at") ?? null,
  };
}

function optionalTime(row: Row, key: string): string | null | undefined {
  if (!(key in row)) return undefined;
  const value = row[key];
  return value ? String(value) : null;
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

