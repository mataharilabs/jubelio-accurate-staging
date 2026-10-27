import type { AppSettings } from "@/lib/db/types";

export function defaultSettings(): AppSettings {
  return {
    defaultCustomerNo: "UMUM",
    defaultCustomerName: "Pelanggan Umum",
    accurateDatabaseId: "",
    requireWarehouse: true,
    customerMappings: [
      { id: "map-shopee", matchType: "channel", matchValue: "SHOPEE", customerNo: "SHOPEE", customerName: "Shopee" },
      { id: "map-shop-tokopedia", matchType: "channel", matchValue: "Shop | Tokopedia", customerNo: "TOKOPEDIA", customerName: "Tokopedia Shop" },
      { id: "map-tokopedia", matchType: "channel", matchValue: "TOKOPEDIA", customerNo: "TOKOPEDIA", customerName: "Tokopedia" },
      { id: "map-lazada", matchType: "channel", matchValue: "LAZADA", customerNo: "LAZADA", customerName: "Lazada" },
      { id: "map-offline", matchType: "channel", matchValue: "Offline market", customerNo: "POS", customerName: "Penjualan Offline" },
      { id: "map-pos", matchType: "channel", matchValue: "JUBELIO-POS", customerNo: "POS", customerName: "Jubelio POS" },
    ],
    locationMappings: [
      { id: "loc-jkt", lokasiGudang: "Lintas Jkt", branchName: "Lintas Jakarta", warehouseName: "Gudang Lintas Jakarta" },
      { id: "loc-sby", lokasiGudang: "Lintas Sby", branchName: "Lintas Surabaya", warehouseName: "Gudang Lintas Surabaya" },
    ],
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizeSettings(input: unknown): AppSettings {
  const base = defaultSettings();
  const data = input && typeof input === "object" ? (input as Partial<AppSettings>) : {};
  const customers = Array.isArray(data.customerMappings) ? data.customerMappings : base.customerMappings;
  const locations = Array.isArray(data.locationMappings) ? data.locationMappings : base.locationMappings;
  return {
    defaultCustomerNo: text(data.defaultCustomerNo ?? base.defaultCustomerNo),
    defaultCustomerName: text(data.defaultCustomerName ?? base.defaultCustomerName),
    accurateDatabaseId: text(data.accurateDatabaseId ?? base.accurateDatabaseId),
    requireWarehouse: typeof data.requireWarehouse === "boolean" ? data.requireWarehouse : base.requireWarehouse,
    customerMappings: customers
      .map((row) => ({
        id: text(row?.id) || crypto.randomUUID(),
        matchType: row?.matchType === "toko" ? "toko" as const : "channel" as const,
        matchValue: text(row?.matchValue),
        customerNo: text(row?.customerNo),
        customerName: text(row?.customerName),
      }))
      .filter((row) => row.matchValue && row.customerNo),
    locationMappings: locations
      .map((row) => ({
        id: text(row?.id) || crypto.randomUUID(),
        lokasiGudang: text(row?.lokasiGudang),
        branchName: text(row?.branchName),
        warehouseName: text(row?.warehouseName),
      }))
      .filter((row) => row.lokasiGudang),
  };
}
