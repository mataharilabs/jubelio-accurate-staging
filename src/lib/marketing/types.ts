export const PLATFORMS = [
  "Shopee Ads",
  "TikTok Ads",
  "Meta Ads",
  "CPAS",
  "Lazada Ads",
  "Blibli Ads",
  "Lainnya",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const NATIVE_PLATFORMS = ["Shopee Ads", "TikTok Ads", "Meta Ads", "CPAS"] as const;

export type SpendSource = "file" | "manual" | "template";

export type SpendDraft = {
  lineNo: number;
  periodStart: string;
  periodEnd: string;
  platform: string;
  storeRaw: string | null;
  campaign: string;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  adsRevenue: number | null;
};

export type SkippedRow = { row: number; reason: string };

export type ParseResult = {
  kind: "shopee" | "tiktok" | "meta" | "cpas" | "template";
  platform: string;
  splitDaily: boolean;
  storeRaw: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rows: SpendDraft[];
  skipped: SkippedRow[];
  readCount: number;
  crossesMonth: boolean;
  monthMessage: string | null;
  note: string | null;
};

export type MarketingRecord = SpendDraft & {
  id: string;
  uploadId: string;
  storeName: string;
  source: SpendSource;
  sourceFile: string;
  createdBy: string;
  createdAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
};

export type DuplicateGroup = {
  platform: string;
  storeName: string;
  count: number;
  periodStart: string;
  periodEnd: string;
  ids: string[];
};

export type MarketingFilter = {
  month: string;
  status: "active" | "deleted" | "all";
};
