import { buyerName } from "@/lib/accurate/customer";
import type { AppSettings, OrderVersion } from "@/lib/db/types";
import { AppError } from "@/lib/errors";
import { accurateDate, formatDecimal } from "@/lib/format";

export const SALES_INVOICE_PATH = "/accurate/api/sales-invoice/save.do";
export const SALES_INVOICE_DELETE_PATH = "/accurate/api/sales-invoice/delete.do";
export const SALES_INVOICE_DETAIL_PATH = "/accurate/api/sales-invoice/detail.do";
export const SALES_INVOICE_LIST_PATH = "/accurate/api/sales-invoice/list.do";

/**
 * sales-invoice/save.do `number` is a string and the public OpenAPI schema does not
 * set maxLength (the sample "Halo Semua 123" is a generic placeholder). 50 is the
 * transaction-number length Accurate Online's form has historically enforced.
 * Longer order numbers are refused here so Accurate does not truncate or reject them.
 */
export const ACCURATE_INVOICE_NUMBER_MAX = 50;

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

export type ResolvedCustomer = { customerNo: string; customerName: string };

/**
 * Buyer name always wins. Channel/store customerMappings are not used.
 * A resolved Accurate customerNo is required when the order has a buyer name.
 * The default customer is only used when the buyer name is empty.
 */
function resolveCustomer(version: OrderVersion, settings: AppSettings, resolved?: ResolvedCustomer | null): { customerNo: string; customerName: string } | null {
  const name = buyerName(version.customerName);
  if (name) {
    if (resolved?.customerNo) return { customerNo: resolved.customerNo, customerName: resolved.customerName || name };
    return null;
  }
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

/** Manual invoice number. Null when it can be sent as sales-invoice/save.do `number`. */
export function invoiceNumberError(noPesanan: string): string | null {
  const number = noPesanan ?? "";
  if (!number.trim()) return "Nomor pesanan kosong, tidak bisa dipakai sebagai nomor faktur Accurate.";
  if (number.length > ACCURATE_INVOICE_NUMBER_MAX) {
    const shown = number.length > 80 ? `${number.slice(0, 80)}…` : number;
    return `Nomor pesanan "${shown}" terlalu panjang untuk nomor faktur Accurate (${number.length} karakter, maksimal ${ACCURATE_INVOICE_NUMBER_MAX}).`;
  }
  return null;
}

/** list.do exact match on the transaction number. */
export function invoiceListQuery(number: string): string {
  const params = new URLSearchParams();
  params.set("fields", "id,number");
  params.set("sp.page", "1");
  params.set("sp.pageSize", "20");
  params.set("filter.number.op", "EQUAL");
  params.set("filter.number.val", number);
  return params.toString();
}

export type ExistingInvoice = { id: string; number: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function invoiceRows(bucket: unknown): Record<string, unknown>[] {
  if (Array.isArray(bucket)) {
    return bucket.flatMap((item) => {
      const record = asRecord(item);
      return record ? [record] : [];
    });
  }
  const record = asRecord(bucket);
  if (!record) return [];
  const nested = invoiceRows(record.d ?? record.list ?? record.data);
  const self = record.id != null || record.number != null || record.no != null ? [record] : [];
  return [...self, ...nested];
}

/** Read one invoice whose number matches exactly. Not-found is null; other Accurate errors throw. */
export function readExistingInvoice(body: unknown, number: string): ExistingInvoice | null {
  const json = asRecord(body) ?? {};
  if (json.s === false) {
    const detail = Array.isArray(json.d) ? json.d.map(String).join(" ") : text(json.d);
    if (!detail || /not found|tidak ditemukan|no data|tidak ada/i.test(detail)) return null;
    throw new AppError(detail);
  }
  for (const row of [...invoiceRows(json.d), ...invoiceRows(json.r)]) {
    const id = text(row.id);
    const found = text(row.number || row.no);
    if (id && found === number) return { id, number };
  }
  return null;
}

export function invoiceUrl(host: string): string {
  return `${host.replace(/\/$/, "")}${SALES_INVOICE_PATH}`;
}

export function deleteInvoiceUrl(host: string): string {
  return `${host.replace(/\/$/, "")}${SALES_INVOICE_DELETE_PATH}`;
}

/** Line totals already include PPN. Accurate's invoice total is this net. */
export function invoiceTotals(version: OrderVersion): { gross: number; discount: number; net: number } {
  const gross = version.lines.reduce((sum, line) => sum + (line.subTotal ?? 0), 0);
  const discount = version.lines.reduce((sum, line) => sum + (line.unitDiskon ?? 0) * line.qty, 0);
  return { gross, discount, net: gross - discount };
}

/**
 * One Accurate sales invoice for one order.
 * `number` is the order number (no_pesanan), on create and on update.
 * typeAutoNumber is omitted so Accurate does not apply an auto-number scheme.
 * Prices are PPN-inclusive: taxable + inclusiveTax, and useTax1 on each line.
 * detailItem[n].unitPrice is the cleaned Unit Price (per piece).
 * itemCashDiscount = Unit Diskon × Qty.
 */
export function buildInvoice(version: OrderVersion, settings: AppSettings, accurateId?: string | null, endpoint = `{host}${SALES_INVOICE_PATH}`, resolved?: ResolvedCustomer | null): InvoiceDraft {
  const warnings: string[] = [];
  const reasons: string[] = [];
  const name = buyerName(version.customerName);
  const customer = resolveCustomer(version, settings, resolved);
  if (!version.lines.length) reasons.push("Pesanan tidak punya baris.");
  if (version.lines.length && !customer) {
    reasons.push(name
      ? `Nama pembeli "${name}" belum dipasangkan ke nomor pelanggan Accurate.`
      : "Pesanan tidak punya nama pembeli dan pelanggan default kosong.");
  }
  const location = version.lokasiGudang
    ? settings.locationMappings.find((row) => same(row.lokasiGudang, version.lokasiGudang ?? ""))
    : undefined;
  if (version.lokasiGudang && settings.requireWarehouse && !location?.warehouseName && !settings.defaultWarehouse) {
    reasons.push(`Gudang belum dipetakan untuk lokasi "${version.lokasiGudang}".`);
  } else if (version.lokasiGudang && !location?.warehouseName && !settings.defaultWarehouse) {
    warnings.push(`Lokasi "${version.lokasiGudang}" belum punya nama gudang Accurate.`);
  }

  const fields: Record<string, string> = {};
  if (accurateId) fields.id = accurateId;
  const numberError = invoiceNumberError(version.noPesanan);
  if (numberError) reasons.push(numberError);
  else fields.number = version.noPesanan;
  if (customer?.customerNo) fields.customerNo = customer.customerNo;
  fields.transDate = accurateDate(version.tanggal ? `${version.tanggal}Z` : null, version.day);
  fields.description = `Jubelio ${version.noPesanan}`.slice(0, 500);
  // Marketplace prices already include 11% PPN. Do not send typeAutoNumber with a manual number.
  fields.taxable = "true";
  fields.inclusiveTax = "true";
  const branchName = location?.branchName || settings.defaultBranch;
  // Satu gudang Accurate (biasanya "Utama") lewat defaultWarehouse bila lokasi tidak punya mapping.
  const warehouseName = location?.warehouseName || settings.defaultWarehouse;
  if (branchName) fields.branchName = branchName;

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
    fields[`detailItem[${index}].useTax1`] = "true";
    fields[`detailItem[${index}].useTax2`] = "false";
    fields[`detailItem[${index}].useTax3`] = "false";
    if (warehouseName) fields[`detailItem[${index}].warehouseName`] = warehouseName;
  });

  const { gross, discount } = invoiceTotals(version);
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
