export const FEE_GROUPS = [
  "Komisi",
  "Biaya layanan/program",
  "Biaya pembayaran",
  "Biaya proses pesanan",
  "Ongkir ditanggung penjual",
  "Komisi afiliasi",
  "Pajak",
  "Lain-lain",
] as const;

export type FeeGroup = (typeof FEE_GROUPS)[number];

export const MARKETPLACES = ["shopee", "lazada", "tiktok", "blibli", "template"] as const;

export type Marketplace = (typeof MARKETPLACES)[number];

/** Zero-fee settlement so the order is not treated as unpaid. */
export const SETTLEMENT_MARKER = "Penyelesaian tanpa biaya";

export type FeeDraft = {
  noPesanan: string;
  /** Blibli Order ID, used only when the composite key is missing in Jubelio. */
  orderId?: string;
  sku: string | null;
  productName?: string;
  feeGroup: FeeGroup;
  feeName: string;
  /** Positive means a cost to the seller. */
  amountRp: number;
  pct: number | null;
  base: string | null;
  reducesProfit: boolean;
  /** True when an order-level amount was spread to SKUs by sales share. */
  allocated: boolean;
  marketplace: Marketplace;
};

export type SalesLine = {
  noPesanan: string;
  sku: string;
  productName: string;
  revenue: number;
  qty: number;
};

export type ParsedFees = {
  marketplace: Marketplace;
  format: string;
  rows: FeeDraft[];
  /** One entry per order seen in the file, including all-zero settlements. */
  orders: { noPesanan: string; orderId?: string }[];
  readCount: number;
};

export function isFeeGroup(value: string): value is FeeGroup {
  return (FEE_GROUPS as readonly string[]).includes(value);
}

export function reducesProfit(group: FeeGroup): boolean {
  return group !== "Pajak";
}
