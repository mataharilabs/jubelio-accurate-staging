export type SyncCategory = "Baru" | "Berubah" | "Returned" | "Batal" | "Status saja" | "Sama";
export type ChangeDecision = "confirmed" | "ignored" | null;
export type VersionSource = "import_raw" | "import_clean" | "manual_edit" | "manual_delete" | "cancel";

export type OrderLine = {
  id: string;
  sku: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
  subTotal: number | null;
  unitDiskon: number | null;
  revenuePerUnit: number | null;
  missingWeight: boolean;
  bundleKey: string | null;
  /** Reserved for a future COGS table. Gross profit = revenue − unitCogs × qty. */
  unitCogs: number | null;
  flags: string[];
};

export type OrderVersion = {
  id: string;
  noPesanan: string;
  versionNo: number;
  importId: string | null;
  source: VersionSource;
  createdAt: string;
  createdBy: string | null;
  isCurrent: boolean;
  tanggal: string;
  day: string;
  channel: string;
  storeName: string;
  customerName: string;
  customerCode: string;
  province: string;
  city: string;
  kurir: string;
  status: string;
  lokasiGudang: string | null;
  totalNilaiPesanan: number | null;
  totalDiskon: number;
  qty: number;
  revenue: number | null;
  lines: OrderLine[];
};

export type FieldChange = {
  id: string;
  noPesanan: string;
  fromVersionId: string | null;
  toVersionId: string;
  field: string;
  kind: "changed" | "added" | "removed";
  oldValue: string | null;
  newValue: string | null;
};

export type ImportRecord = {
  id: string;
  filename: string;
  source: "raw" | "clean" | "sample";
  createdAt: string;
  createdBy: string | null;
  orderCount: number;
  lineCount: number;
  newVersions: number;
  unchanged: number;
  fromDay: string | null;
  toDay: string | null;
};

export type SyncState = {
  noPesanan: string;
  lastSyncedVersionId: string | null;
  accurateId: string | null;
  accurateNumber: string | null;
  lastSyncStatus: "tersinkron" | "gagal" | "void" | null;
  decision: ChangeDecision;
  decisionVersionId: string | null;
  updatedAt: string;
};

export type SyncBatch = {
  id: string;
  createdAt: string;
  createdBy: string | null;
  orderCount: number;
  successCount: number;
  failCount: number;
  totalNilai: number;
  revenue: number;
  note: string;
};

export type SyncBatchItem = {
  id: string;
  batchId: string;
  noPesanan: string;
  versionId: string;
  category: SyncCategory;
  action: "create" | "update" | "delete";
  status: "berhasil" | "gagal";
  accurateId: string | null;
  accurateNumber: string | null;
  error: string | null;
  createdAt: string;
};

export type BundleWeight = {
  id: string;
  bundleKey: string;
  bobot: number;
  updatedAt: string;
};

export type ChannelMapRow = {
  id: string;
  channelRaw: string;
  storeRaw: string;
  channel: string;
  store: string;
  needsReview: boolean;
};

export type ProvinceMapRow = {
  id: string;
  raw: string;
  official: string;
  needsReview: boolean;
};

export type CityMapRow = {
  id: string;
  provinceRaw: string;
  cityRaw: string;
  official: string;
  needsReview: boolean;
};

export type ReviewItem = {
  id: string;
  kind: "channel_store" | "province" | "city" | "bobot";
  rawKey: string;
  detail: Record<string, string>;
  status: "open" | "resolved";
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

export type DashboardQuery = {
  from: string | null;
  to: string | null;
  granularity: "day" | "week" | "month";
  channels: string[];
  stores: string[];
  provinces: string[];
  cities: string[];
  statuses: string[];
  couriers: string[];
  skus: string[];
};

export type GroupRow = { key: string; gross: number; net: number; qty: number; orders: number };
export type ProductRow = GroupRow & { sku: string; name: string; share: number };
export type GeoRow = { key: string; net: number; orders: number; qty: number; share: number };

export type DashboardReport = {
  kpis: { gross: number; disc: number; net: number; orders: number; qty: number; aov: number; days: number };
  trend: { bucket: string; label: string; gross: number; net: number; orders: number }[];
  channels: GroupRow[];
  stores: GroupRow[];
  products: ProductRow[];
  provinces: GeoRow[];
  cities: GeoRow[];
};

export type FilterOptions = {
  channels: string[];
  stores: string[];
  provinces: string[];
  cities: string[];
  statuses: string[];
  couriers: string[];
  skus: string[];
  minDay: string | null;
  maxDay: string | null;
};

export type AppMeta = {
  mode: "local" | "supabase";
  ephemeral: boolean;
  lastImportAt: string | null;
  orderCount: number;
  lineCount: number;
  openReviews: number;
  accurateConnected: boolean;
  accurateConfigured: boolean;
  accurateUser: string | null;
};

export type OrderQuery = {
  day: string | null;
  q: string;
  page: number;
  pageSize: number;
};

export type OrderPageRow = {
  lineId: string;
  versionId: string;
  noPesanan: string;
  tanggal: string;
  day: string;
  channel: string;
  storeName: string;
  sku: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
  subTotal: number | null;
  totalNilaiPesanan: number | null;
  totalDiskon: number;
  unitDiskon: number | null;
  revenuePerUnit: number | null;
  customerName: string;
  customerCode: string;
  province: string;
  city: string;
  kurir: string;
  status: string;
  flags: string[];
};

export type OrderPage = {
  total: number;
  orders: number;
  page: number;
  pages: number;
  rows: OrderPageRow[];
};

export type SyncReviewRow = {
  noPesanan: string;
  day: string;
  category: SyncCategory;
  decision: ChangeDecision;
  selectable: boolean;
  summary: string;
  current: OrderVersion;
  baseline: OrderVersion | null;
  changes: FieldChange[];
  accurateNumber: string | null;
};

export type ImportResult = {
  importId: string;
  orders: number;
  lines: number;
  newVersions: number;
  unchanged: number;
  dropped: number;
  reviews: number;
};
