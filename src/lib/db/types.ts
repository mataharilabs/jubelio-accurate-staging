export type SyncStatus = "belum" | "pratinjau" | "tersinkron" | "gagal";

export type SalesLine = {
  id: string;
  batchId: string;
  rowIndex: number;
  noPesanan: string;
  noPesananSumber: string | null;
  channel: string;
  sku: string;
  qty: number;
  hargaJual: number | null;
  totalDiskon: number | null;
  tanggal: string | null;
  lokasiGudang: string | null;
  namaToko: string | null;
  status: string | null;
  namaBarang: string | null;
  sourceSku: string | null;
  isBundle: boolean;
  bundleKey: string | null;
  bobot: number | null;
  missingWeight: boolean;
  isShopee: boolean;
  syncStatus: SyncStatus;
  sourceQty: number;
  sourceHarga: number;
  sourceTotalPenjualan: number;
  sourceDiskon: number;
  sourceDiskonLainnya: number;
  sourceBiayaLainnya: number;
  sourceQtyBundle: number;
};

export type NewLine = Omit<SalesLine, "id" | "batchId" | "syncStatus">;

export type LinePatch = {
  noPesanan?: string;
  channel?: string;
  sku?: string;
  qty?: number;
  hargaJual?: number;
  totalDiskon?: number;
  lokasiGudang?: string | null;
  namaToko?: string | null;
  status?: string | null;
};

export type Batch = {
  id: string;
  reportDate: string;
  filename: string;
  rowCount: number;
  droppedCount: number;
  missingWeightCount: number;
  grossTotal: number;
  discountTotal: number;
  orderCount: number;
  unsyncedCount: number;
  createdAt: string;
  createdBy: string | null;
};

export type OrderSync = {
  id: string;
  batchId: string;
  noPesanan: string;
  status: SyncStatus;
  accurateId: string | null;
  accurateNumber: string | null;
  payload: unknown;
  response: unknown;
  error: string | null;
  syncedAt: string | null;
  syncedBy: string | null;
};

export type BundleWeight = {
  id: string;
  bundleKey: string;
  bobot: number;
  updatedAt: string;
};

export type CustomerMapping = {
  id: string;
  matchType: "toko" | "channel";
  matchValue: string;
  customerNo: string;
  customerName: string;
};

export type LocationMapping = {
  id: string;
  lokasiGudang: string;
  branchName: string;
  warehouseName: string;
};

export type AppSettings = {
  customerMappings: CustomerMapping[];
  locationMappings: LocationMapping[];
  defaultCustomerNo: string;
  defaultCustomerName: string;
  accurateDatabaseId: string;
  requireWarehouse: boolean;
};

export type AccurateTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  userEmail: string | null;
  updatedAt: string;
};

export type DashboardStats = {
  batchCount: number;
  lineCount: number;
  grossTotal: number;
  discountTotal: number;
  unsyncedOrders: number;
  missingWeights: number;
  weightCount: number;
};

export type CreateBatchInput = {
  filename: string;
  reportDate: string;
  droppedCount: number;
  createdBy: string | null;
  lines: NewLine[];
};
