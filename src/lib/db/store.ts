import type { CleanLine } from "@/lib/cleanup/rapikan";
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

export type PreparedSync = {
  row: SyncReviewRow;
  state: SyncState | null;
};

export type SyncWrite = {
  noPesanan: string;
  versionId: string;
  category: SyncReviewRow["category"];
  action: "create" | "update" | "delete";
  status: "berhasil" | "gagal";
  accurateId: string | null;
  accurateNumber: string | null;
  error: string | null;
};

export interface DataStore {
  mode: "local" | "supabase";
  ephemeral: boolean;
  ensureSeeded(): Promise<void>;
  meta(): Promise<AppMeta>;
  dashboard(query: DashboardQuery): Promise<DashboardReport>;
  filterOptions(): Promise<FilterOptions>;
  listOrders(query: OrderQuery): Promise<OrderPage>;
  editLine(noPesanan: string, lineId: string, patch: { sku?: string; qty?: number; unitPrice?: number; city?: string }, by: string): Promise<void>;
  deleteLine(noPesanan: string, lineId: string, by: string): Promise<void>;
  setDataStatus(noPesanan: string, dataStatus: "active" | "deleted"): Promise<void>;
  applyReturn(noPesanan: string, input: { status: string; returnCase: 1 | 2 | 3 | null; lost: { sku: string; qty: number }[] }, by: string): Promise<void>;
  logSync(entry: { actor: string | null; action: "sync" | "ignore" | "blocked"; noPesanan: string; note?: string }): Promise<void>;
  listSyncLog(): Promise<{ at: string; actor: string | null; action: string; noPesanan: string; note: string }[]>;
  importCleanLines(lines: CleanLine[], filename: string, source: "clean" | "sample", by: string | null, duplicate?: "overwrite" | "skip"): Promise<ImportResult>;
  importRawLines(lines: CleanLine[], cancels: { noPesanan: string; status: string; day: string | null; tanggal: string | null }[], filename: string, by: string | null, range: { from: string | null; to: string | null }, source?: "raw" | "api", duplicate?: "overwrite" | "skip"): Promise<ImportResult>;
  syncReview(days: string[]): Promise<SyncReviewRow[]>;
  prepareSync(nos: string[]): Promise<PreparedSync[]>;
  setDecision(noPesanan: string, decision: "confirmed" | "ignored", by: string): Promise<void>;
  recordSync(by: string, items: SyncWrite[], note: string): Promise<SyncBatch>;
  syncHistory(): Promise<{ batches: SyncBatch[]; items: SyncBatchItem[] }>;
  orderHistory(noPesanan: string): Promise<{ versions: OrderVersion[]; changes: FieldChange[]; items: SyncBatchItem[] }>;
  listChannelMaps(): Promise<ChannelMapRow[]>;
  saveChannelMap(row: Omit<ChannelMapRow, "id"> & { id?: string }): Promise<void>;
  deleteChannelMap(id: string): Promise<void>;
  listProvinceMaps(): Promise<ProvinceMapRow[]>;
  saveProvinceMap(row: Omit<ProvinceMapRow, "id"> & { id?: string }): Promise<void>;
  listCityMaps(): Promise<CityMapRow[]>;
  saveCityMap(row: Omit<CityMapRow, "id"> & { id?: string }): Promise<void>;
  listWeights(): Promise<BundleWeight[]>;
  upsertWeights(rows: { bundleKey: string; bobot: number }[], replace: boolean): Promise<number>;
  updateWeight(id: string, patch: { bundleKey?: string; bobot?: number }): Promise<BundleWeight>;
  deleteWeight(id: string): Promise<void>;
  listBundleComponents(): Promise<BundleComponent[]>;
  saveBundle(bundleSku: string, components: { sku: string; qty: number; weightPct: number }[]): Promise<void>;
  deleteBundle(bundleSku: string): Promise<void>;
  clearBundleComponents(): Promise<void>;
  listOrderedSkus(): Promise<string[]>;
  listReviews(): Promise<ReviewItem[]>;
  resolveReview(id: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  getTokens(): Promise<AccurateTokens | null>;
  saveTokens(tokens: AccurateTokens | null): Promise<void>;
  currentVersions(): Promise<OrderVersion[]>;
  createManualOrder(version: OrderVersion): Promise<void>;
}
