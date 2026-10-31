import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CleanLine } from "@/lib/cleanup/rapikan";
import { sanitizeSettings } from "@/lib/db/defaults";
import { planCancels, planImport } from "@/lib/domain/plan";
import { applyLineEdit, diffVersions, orderRevenue } from "@/lib/domain/orders";
import { reportOf } from "@/lib/domain/aggregate";
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
  OrderPage,
  OrderQuery,
  OrderVersion,
  ProvinceMapRow,
  ReviewItem,
  SyncBatch,
  SyncBatchItem,
  SyncReviewRow,
  SyncState,
} from "@/lib/db/types";
import { accurateConfigured } from "@/lib/env";
import { AppError } from "@/lib/errors";

type LocalDB = {
  version: 2;
  imports: ImportRecord[];
  versions: OrderVersion[];
  changes: FieldChange[];
  syncStates: SyncState[];
  syncBatches: SyncBatch[];
  syncItems: SyncBatchItem[];
  weights: BundleWeight[];
  channels: ChannelMapRow[];
  provinces: ProvinceMapRow[];
  cities: CityMapRow[];
  reviews: ReviewItem[];
  settings: AppSettings;
  tokens: AccurateTokens | null;
};

const FILE = path.join(process.cwd(), "data", "store-v2.json");

function emptyDb(): LocalDB {
  return {
    version: 2,
    imports: [],
    versions: [],
    changes: [],
    syncStates: [],
    syncBatches: [],
    syncItems: [],
    weights: [],
    channels: [],
    provinces: [],
    cities: [],
    reviews: [],
    settings: sanitizeSettings(null),
    tokens: null,
  };
}

function load(): LocalDB {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as LocalDB;
    if (parsed.version !== 2) return emptyDb();
    parsed.settings = sanitizeSettings(parsed.settings);
    return parsed;
  } catch {
    return emptyDb();
  }
}

function save(db: LocalDB) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db));
}

function currentMap(db: LocalDB): Map<string, OrderVersion> {
  const map = new Map<string, OrderVersion>();
  for (const version of db.versions) if (version.isCurrent) map.set(version.noPesanan, version);
  return map;
}

function addReviews(db: LocalDB, items: Omit<ReviewItem, "id" | "status">[]) {
  for (const item of items) {
    const existing = db.reviews.find((row) => row.kind === item.kind && row.rawKey === item.rawKey);
    if (existing) {
      if (existing.status === "resolved") continue;
      existing.detail = item.detail;
      continue;
    }
    db.reviews.push({ ...item, id: crypto.randomUUID(), status: "open" });
  }
}

export class LocalStore implements DataStore {
  mode = "local" as const;
  ephemeral = false;
  private db: LocalDB;

  constructor() {
    this.db = load();
  }

  private persist() {
    save(this.db);
  }

  async ensureSeeded(): Promise<void> {
    const { seedReferenceData, seedSampleSales } = await import("@/lib/sample-data");
    if (!this.db.weights.length || !this.db.channels.length) await seedReferenceData(this);
    if (!this.db.versions.length) await seedSampleSales(this);
  }

  async meta(): Promise<AppMeta> {
    const current = this.db.versions.filter((version) => version.isCurrent && version.source !== "cancel" && version.source !== "manual_delete");
    const last = [...this.db.imports].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return {
      mode: this.mode,
      ephemeral: false,
      lastImportAt: last?.createdAt ?? null,
      orderCount: current.length,
      lineCount: current.reduce((sum, version) => sum + version.lines.length, 0),
      openReviews: this.db.reviews.filter((row) => row.status === "open").length,
      accurateConnected: Boolean(this.db.tokens?.accessToken),
      accurateConfigured: accurateConfigured(),
      accurateUser: this.db.tokens?.userEmail ?? null,
    };
  }

  async dashboard(query: DashboardQuery): Promise<DashboardReport> {
    return reportOf(this.db.versions, query);
  }

  async filterOptions(): Promise<FilterOptions> {
    const versions = this.db.versions.filter((version) => version.isCurrent && version.source !== "cancel" && version.source !== "manual_delete");
    const uniq = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
    const days = versions.map((version) => version.day).filter(Boolean).sort();
    return {
      channels: uniq(versions.map((version) => version.channel)),
      stores: uniq(versions.map((version) => version.storeName)),
      provinces: uniq(versions.map((version) => version.province)),
      cities: uniq(versions.map((version) => version.city)),
      statuses: uniq(versions.map((version) => version.status)),
      couriers: uniq(versions.map((version) => version.kurir)),
      skus: uniq(versions.flatMap((version) => version.lines.map((line) => line.sku))),
      minDay: days[0] ?? null,
      maxDay: days.at(-1) ?? null,
    };
  }

  async listOrders(query: OrderQuery): Promise<OrderPage> {
    const q = query.q.trim().toLowerCase();
    const rows = this.db.versions
      .filter((version) => version.isCurrent && version.source !== "cancel" && version.source !== "manual_delete")
      .flatMap((version) => version.lines.map((line) => ({ version, line })))
      .filter(({ version, line }) => {
        if (query.day && version.day !== query.day) return false;
        if (!q) return true;
        const hay = [version.noPesanan, line.sku, line.productName, version.customerName, version.storeName, version.city, version.channel].join(" ").toLowerCase();
        return hay.includes(q);
      });
    const pageSize = query.pageSize || 30;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(query.page, pages - 1);
    const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
    return {
      total: rows.length,
      orders: new Set(rows.map((row) => row.version.noPesanan)).size,
      page,
      pages,
      rows: slice.map(({ version, line }) => ({
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

  private commitPlan(plan: ReturnType<typeof planImport>, record: ImportRecord | null) {
    for (const id of plan.retireIds) {
      const version = this.db.versions.find((row) => row.id === id);
      if (version) version.isCurrent = false;
    }
    this.db.versions.push(...plan.versions);
    this.db.changes.push(...plan.changes);
    addReviews(this.db, plan.reviews);
    if (record) this.db.imports.push(record);
    this.persist();
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
    const createdAt = new Date().toISOString();
    const importId = crypto.randomUUID();
    const current = currentMap(this.db);
    const plan = planImport(current, lines, { importId, source: source === "raw" ? "import_raw" : "import_clean", createdAt, createdBy: by });
    const cancelPlan = planCancels(current, cancels, { importId, createdAt, createdBy: by });
    const versions = [...plan.versions, ...cancelPlan.versions];
    const record: ImportRecord = {
      id: importId,
      filename,
      source,
      createdAt,
      createdBy: by,
      orderCount: new Set(lines.map((line) => line.noPesanan)).size,
      lineCount: lines.length,
      newVersions: versions.length,
      unchanged: plan.unchanged,
      fromDay: range.from,
      toDay: range.to,
    };
    this.commitPlan({
      versions,
      changes: [...plan.changes, ...cancelPlan.changes],
      retireIds: [...plan.retireIds, ...cancelPlan.retireIds],
      reviews: [...plan.reviews, ...cancelPlan.reviews],
      unchanged: plan.unchanged,
    }, record);
    return {
      importId,
      orders: record.orderCount,
      lines: lines.length,
      newVersions: versions.length,
      unchanged: plan.unchanged,
      dropped: cancels.length,
      reviews: plan.reviews.length,
    };
  }

  private replaceCurrent(previous: OrderVersion, next: OrderVersion) {
    previous.isCurrent = false;
    this.db.versions.push(next);
    this.db.changes.push(...diffVersions(previous, next));
    const state = this.db.syncStates.find((row) => row.noPesanan === next.noPesanan);
    if (state && state.decisionVersionId !== next.id) {
      state.decision = null;
      state.decisionVersionId = null;
    }
    this.persist();
  }

  async editLine(noPesanan: string, lineId: string, patch: { sku?: string; qty?: number; unitPrice?: number; city?: string }, by: string): Promise<void> {
    const previous = currentMap(this.db).get(noPesanan);
    if (!previous) throw new AppError("Pesanan tidak ditemukan.");
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
    this.replaceCurrent(previous, next);
  }

  async deleteLine(noPesanan: string, lineId: string, by: string): Promise<void> {
    const previous = currentMap(this.db).get(noPesanan);
    if (!previous) throw new AppError("Pesanan tidak ditemukan.");
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
    this.replaceCurrent(previous, next);
  }

  async syncReview(days: string[]): Promise<SyncReviewRow[]> {
    const wanted = new Set(days);
    const rows: SyncReviewRow[] = [];
    for (const version of this.db.versions) {
      if (!version.isCurrent) continue;
      if (wanted.size && !wanted.has(version.day)) continue;
      const state = this.db.syncStates.find((row) => row.noPesanan === version.noPesanan) ?? null;
      const synced = state?.lastSyncedVersionId ? this.db.versions.find((row) => row.id === state.lastSyncedVersionId) ?? null : null;
      const row = reviewRow(version, synced, state);
      if (row) rows.push(row);
    }
    return rows.sort((a, b) => b.day.localeCompare(a.day) || a.noPesanan.localeCompare(b.noPesanan));
  }

  async prepareSync(nos: string[]): Promise<PreparedSync[]> {
    const review = await this.syncReview([]);
    const wanted = new Set(nos);
    return review.filter((row) => wanted.has(row.noPesanan)).map((row) => ({
      row,
      state: this.db.syncStates.find((item) => item.noPesanan === row.noPesanan) ?? null,
    }));
  }

  async setDecision(noPesanan: string, decision: "confirmed" | "ignored", by: string): Promise<void> {
    const version = currentMap(this.db).get(noPesanan);
    if (!version) throw new AppError("Pesanan tidak ditemukan.");
    const now = new Date().toISOString();
    const existing = this.db.syncStates.find((row) => row.noPesanan === noPesanan);
    if (existing) {
      existing.decision = decision;
      existing.decisionVersionId = version.id;
      existing.updatedAt = now;
    } else {
      this.db.syncStates.push({
        noPesanan,
        lastSyncedVersionId: null,
        accurateId: null,
        accurateNumber: null,
        lastSyncStatus: null,
        decision,
        decisionVersionId: version.id,
        updatedAt: now,
      });
    }
    void by;
    this.persist();
  }

  async recordSync(by: string, items: SyncWrite[], note: string): Promise<SyncBatch> {
    const batch: SyncBatch = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      createdBy: by,
      orderCount: items.length,
      successCount: items.filter((item) => item.status === "berhasil").length,
      failCount: items.filter((item) => item.status === "gagal").length,
      totalNilai: 0,
      revenue: 0,
      note,
    };
    for (const item of items) {
      const version = this.db.versions.find((row) => row.id === item.versionId);
      if (item.status === "berhasil" && version) {
        batch.totalNilai += version.totalNilaiPesanan ?? 0;
        batch.revenue += version.revenue ?? 0;
      }
      this.db.syncItems.push({
        id: crypto.randomUUID(),
        batchId: batch.id,
        noPesanan: item.noPesanan,
        versionId: item.versionId,
        category: item.category,
        action: item.action,
        status: item.status,
        accurateId: item.accurateId,
        accurateNumber: item.accurateNumber,
        error: item.error,
        createdAt: batch.createdAt,
      });
      if (item.status !== "berhasil") continue;
      const state = this.db.syncStates.find((row) => row.noPesanan === item.noPesanan);
      const next: SyncState = {
        noPesanan: item.noPesanan,
        lastSyncedVersionId: item.action === "delete" ? state?.lastSyncedVersionId ?? item.versionId : item.versionId,
        accurateId: item.action === "delete" ? null : item.accurateId,
        accurateNumber: item.action === "delete" ? null : item.accurateNumber,
        lastSyncStatus: item.action === "delete" ? "void" : "tersinkron",
        decision: null,
        decisionVersionId: null,
        updatedAt: batch.createdAt,
      };
      if (state) Object.assign(state, next);
      else this.db.syncStates.push(next);
    }
    this.db.syncBatches.unshift(batch);
    this.persist();
    return batch;
  }

  async syncHistory() {
    return { batches: this.db.syncBatches, items: this.db.syncItems };
  }

  async orderHistory(noPesanan: string) {
    return {
      versions: this.db.versions.filter((version) => version.noPesanan === noPesanan).sort((a, b) => a.versionNo - b.versionNo),
      changes: this.db.changes.filter((change) => change.noPesanan === noPesanan),
      items: this.db.syncItems.filter((item) => item.noPesanan === noPesanan),
    };
  }

  async listChannelMaps() { return this.db.channels; }
  async saveChannelMap(row: Omit<ChannelMapRow, "id"> & { id?: string }) {
    const id = row.id || crypto.randomUUID();
    const next = { ...row, id, needsReview: row.needsReview ?? false };
    const index = this.db.channels.findIndex((item) => item.id === id || (item.channelRaw === row.channelRaw && item.storeRaw === row.storeRaw));
    if (index >= 0) this.db.channels[index] = { ...this.db.channels[index], ...next, id: this.db.channels[index].id };
    else this.db.channels.push(next);
    this.persist();
  }
  async deleteChannelMap(id: string) {
    this.db.channels = this.db.channels.filter((row) => row.id !== id);
    this.persist();
  }
  async listProvinceMaps() { return this.db.provinces; }
  async saveProvinceMap(row: Omit<ProvinceMapRow, "id"> & { id?: string }) {
    const id = row.id || crypto.randomUUID();
    const index = this.db.provinces.findIndex((item) => item.id === id || item.raw === row.raw);
    const next = { ...row, id, needsReview: row.needsReview ?? false };
    if (index >= 0) this.db.provinces[index] = { ...this.db.provinces[index], ...next, id: this.db.provinces[index].id };
    else this.db.provinces.push(next);
    this.persist();
  }
  async listCityMaps() { return this.db.cities; }
  async saveCityMap(row: Omit<CityMapRow, "id"> & { id?: string }) {
    const id = row.id || crypto.randomUUID();
    const index = this.db.cities.findIndex((item) => item.id === id || (item.provinceRaw === row.provinceRaw && item.cityRaw === row.cityRaw));
    const next = { ...row, id, needsReview: row.needsReview ?? false };
    if (index >= 0) this.db.cities[index] = { ...this.db.cities[index], ...next, id: this.db.cities[index].id };
    else this.db.cities.push(next);
    this.persist();
  }
  async listWeights() { return this.db.weights; }
  async upsertWeights(rows: { bundleKey: string; bobot: number }[], replace: boolean) {
    if (replace) this.db.weights = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      const key = row.bundleKey.trim();
      if (!key) continue;
      const existing = this.db.weights.find((item) => item.bundleKey === key);
      if (existing) {
        existing.bobot = row.bobot;
        existing.updatedAt = now;
      } else {
        this.db.weights.push({ id: crypto.randomUUID(), bundleKey: key, bobot: row.bobot, updatedAt: now });
      }
    }
    this.persist();
    return rows.length;
  }
  async updateWeight(id: string, patch: { bundleKey?: string; bobot?: number }) {
    const row = this.db.weights.find((item) => item.id === id);
    if (!row) throw new AppError("Bobot tidak ditemukan.");
    if (patch.bundleKey) row.bundleKey = patch.bundleKey.trim();
    if (patch.bobot != null) row.bobot = patch.bobot;
    row.updatedAt = new Date().toISOString();
    this.persist();
    return row;
  }
  async deleteWeight(id: string) {
    this.db.weights = this.db.weights.filter((row) => row.id !== id);
    this.persist();
  }
  async listReviews() { return this.db.reviews; }
  async resolveReview(id: string) {
    const row = this.db.reviews.find((item) => item.id === id);
    if (row) row.status = "resolved";
    this.persist();
  }
  async getSettings() { return this.db.settings; }
  async saveSettings(settings: AppSettings) {
    this.db.settings = sanitizeSettings(settings);
    this.persist();
    return this.db.settings;
  }
  async getTokens() { return this.db.tokens; }
  async saveTokens(tokens: AccurateTokens | null) {
    this.db.tokens = tokens;
    this.persist();
  }
  async currentVersions() {
    return this.db.versions.filter((version) => version.isCurrent);
  }
}
