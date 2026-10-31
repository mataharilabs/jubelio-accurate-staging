import type { CleanLine } from "@/lib/cleanup/rapikan";
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
  importCleanLines(lines: CleanLine[], filename: string, source: "clean" | "sample", by: string | null): Promise<ImportResult>;
  importRawLines(lines: CleanLine[], cancels: { noPesanan: string; status: string; day: string | null; tanggal: string | null }[], filename: string, by: string | null, range: { from: string | null; to: string | null }): Promise<ImportResult>;
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
  listReviews(): Promise<ReviewItem[]>;
  resolveReview(id: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  getTokens(): Promise<AccurateTokens | null>;
  saveTokens(tokens: AccurateTokens | null): Promise<void>;
  currentVersions(): Promise<OrderVersion[]>;
}
