import { accurateDate, formatDecimal } from "@/lib/format";
import type { AppSettings, OrderVersion } from "@/lib/db/types";

export const SALES_INVOICE_PATH = "/accurate/api/sales-invoice/save.do";
export const SALES_INVOICE_DELETE_PATH = "/accurate/api/sales-invoice/delete.do";

export type InvoiceDraft = {
  noPesanan: string;
  endpoint: string;
  method: "POST";
  headers: Record<string, string>;
  fields: Record<string, string>;
  body: string;
  warnings: string[];
  blockedReason: string | null;
  customerName: string | null;
  gross: number;
  discount: number;
  net: number;
  action: "create" | "update" | "delete";
};

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function resolveCustomer(version: OrderVersion, settings: AppSettings): { customerNo: string; customerName: string } | null {
  const byToko = version.storeName
    ? settings.customerMappings.find((row) => row.matchType === "toko" && same(row.matchValue, version.storeName))
    : undefined;
  if (byToko?.customerNo) return { customerNo: byToko.customerNo, customerName: byToko.customerName || byToko.customerNo };
  const byChannel = version.channel
    ? settings.customerMappings.find((row) => row.matchType === "channel" && same(row.matchValue, version.channel))
    : undefined;
  if (byChannel?.customerNo) return { customerNo: byChannel.customerNo, customerName: byChannel.customerName || byChannel.customerNo };
  if (settings.defaultCustomerNo) {
    return { customerNo: settings.defaultCustomerNo, customerName: settings.defaultCustomerName || settings.defaultCustomerNo };
  }
  return null;
}

export function encodeBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value);
  return params.toString();
}

export function invoiceUrl(host: string): string {
  return `${host.replace(/\/$/, "")}${SALES_INVOICE_PATH}`;
}

export function deleteInvoiceUrl(host: string): string {
  return `${host.replace(/\/$/, "")}${SALES_INVOICE_DELETE_PATH}`;
}

/**
 * One Accurate sales invoice for one order.
 * detailItem[n].unitPrice is the cleaned Unit Price (per piece).
 * itemCashDiscount = Unit Diskon × Qty.
 */
export function buildInvoice(version: OrderVersion, settings: AppSettings, accurateId?: string | null, endpoint = `{host}${SALES_INVOICE_PATH}`): InvoiceDraft {
  const warnings: string[] = [];
  const reasons: string[] = [];
  const customer = resolveCustomer(version, settings);
  if (!version.lines.length) reasons.push("Pesanan tidak punya baris.");
  if (version.lines.length && !customer) {
    reasons.push(`Pelanggan Accurate belum dipetakan untuk channel "${version.channel}" / toko "${version.storeName}".`);
  }
  const location = version.lokasiGudang
    ? settings.locationMappings.find((row) => same(row.lokasiGudang, version.lokasiGudang ?? ""))
    : undefined;
  if (version.lokasiGudang && settings.requireWarehouse && !location?.warehouseName) {
    reasons.push(`Gudang belum dipetakan untuk lokasi "${version.lokasiGudang}".`);
  } else if (version.lokasiGudang && !location?.warehouseName) {
    warnings.push(`Lokasi "${version.lokasiGudang}" belum punya nama gudang Accurate.`);
  }

  const fields: Record<string, string> = {};
  if (accurateId) fields.id = accurateId;
  if (customer?.customerNo) fields.customerNo = customer.customerNo;
  fields.transDate = accurateDate(version.tanggal ? `${version.tanggal}Z` : null, version.day);
  fields.description = `Jubelio ${version.noPesanan}`.slice(0, 500);
  if (location?.branchName) fields.branchName = location.branchName;

  version.lines.forEach((line, index) => {
    if (line.missingWeight || line.unitPrice == null || line.unitDiskon == null) {
      reasons.push(`Bobot bundle tidak ada untuk ${line.bundleKey || line.sku}.`);
    }
    if (!line.sku) reasons.push("Ada baris tanpa SKU.");
    if (!(line.qty > 0)) reasons.push(`Qty SKU ${line.sku || "—"} tidak valid.`);
    fields[`detailItem[${index}].itemNo`] = line.sku;
    fields[`detailItem[${index}].quantity`] = formatDecimal(line.qty, 4);
    fields[`detailItem[${index}].unitPrice`] = formatDecimal(line.unitPrice ?? 0);
    fields[`detailItem[${index}].itemCashDiscount`] = formatDecimal((line.unitDiskon ?? 0) * line.qty);
    if (location?.warehouseName) fields[`detailItem[${index}].warehouseName`] = location.warehouseName;
  });

  const gross = version.lines.reduce((sum, line) => sum + (line.subTotal ?? 0), 0);
  const discount = version.lines.reduce((sum, line) => sum + (line.unitDiskon ?? 0) * line.qty, 0);
  const unique = [...new Set(reasons)];
  return {
    noPesanan: version.noPesanan,
    endpoint,
    method: "POST",
    headers: {
      Authorization: "Bearer <access_token>",
      "X-Session-ID": "<session dari open-db>",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    fields,
    body: encodeBody(fields),
    warnings: [...new Set(warnings)],
    blockedReason: unique.length ? unique.join(" ") : null,
    customerName: customer?.customerName ?? null,
    gross,
    discount,
    net: gross - discount,
    action: accurateId ? "update" : "create",
  };
}

export function buildDeleteInvoice(noPesanan: string, accurateId: string): InvoiceDraft {
  const fields = { id: accurateId };
  return {
    noPesanan,
    endpoint: `{host}${SALES_INVOICE_DELETE_PATH}`,
    method: "POST",
    headers: {
      Authorization: "Bearer <access_token>",
      "X-Session-ID": "<session dari open-db>",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    fields,
    body: encodeBody(fields),
    warnings: ["SOP penghapusan invoice di Accurate belum final. Permintaan ini memanggil sales-invoice/delete.do."],
    blockedReason: accurateId ? null : "Tidak ada id faktur Accurate untuk dihapus.",
    customerName: null,
    gross: 0,
    discount: 0,
    net: 0,
    action: "delete",
  };
}
