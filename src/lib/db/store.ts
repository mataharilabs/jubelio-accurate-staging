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
} from "@/lib/db/types";

export type BatchBundle = {
  batch: Batch;
  lines: SalesLine[];
  syncs: OrderSync[];
};

export type OrderSyncInput = {
  batchId: string;
  noPesanan: string;
  status: OrderSync["status"];
  accurateId?: string | null;
  accurateNumber?: string | null;
  payload?: unknown;
  response?: unknown;
  error?: string | null;
  syncedAt?: string | null;
  syncedBy?: string | null;
};

export interface DataStore {
  mode: "local" | "supabase";
  ephemeral: boolean;
  dashboard(): Promise<{ batches: Batch[]; stats: DashboardStats }>;
  getBatchBundle(id: string): Promise<BatchBundle | null>;
  createBatch(input: CreateBatchInput): Promise<Batch>;
  deleteBatch(id: string): Promise<void>;
  updateLine(id: string, patch: LinePatch): Promise<SalesLine>;
  deleteLines(ids: string[]): Promise<{ deleted: number; blocked: number }>;
  listWeights(): Promise<BundleWeight[]>;
  upsertWeights(rows: { bundleKey: string; bobot: number }[], replace: boolean): Promise<number>;
  updateWeight(id: string, patch: { bundleKey?: string; bobot?: number }): Promise<BundleWeight>;
  deleteWeight(id: string): Promise<void>;
  weightMap(): Promise<Map<string, number>>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  getTokens(): Promise<AccurateTokens | null>;
  saveTokens(tokens: AccurateTokens | null): Promise<void>;
  linesForOrders(batchId: string, orderNos: string[]): Promise<SalesLine[]>;
  saveOrderSync(input: OrderSyncInput): Promise<OrderSync>;
  findSyncedElsewhere(noPesanan: string, batchId: string): Promise<OrderSync | null>;
  resetOrder(batchId: string, noPesanan: string): Promise<void>;
  recalcBatch(batchId: string): Promise<{ updated: number; skipped: number }>;
}
