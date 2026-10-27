import { accurateDate, formatDecimal } from "@/lib/format";
import type { AppSettings, SalesLine } from "@/lib/db/types";

export const SALES_INVOICE_PATH = "/accurate/api/sales-invoice/save.do";

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
};

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function resolveCustomer(line: SalesLine, settings: AppSettings): { customerNo: string; customerName: string } | null {
  const toko = line.namaToko?.trim() ?? "";
  const channel = line.channel.trim();
  const byToko = toko
    ? settings.customerMappings.find((row) => row.matchType === "toko" && same(row.matchValue, toko))
    : undefined;
  if (byToko?.customerNo) return { customerNo: byToko.customerNo, customerName: byToko.customerName || byToko.customerNo };
  const byChannel = channel
    ? settings.customerMappings.find((row) => row.matchType === "channel" && same(row.matchValue, channel))
    : undefined;
  if (byChannel?.customerNo) {
    return { customerNo: byChannel.customerNo, customerName: byChannel.customerName || byChannel.customerNo };
  }
  if (settings.defaultCustomerNo) {
    return {
      customerNo: settings.defaultCustomerNo,
      customerName: settings.defaultCustomerName || settings.defaultCustomerNo,
    };
  }
  return null;
}

function resolveLocation(lokasi: string | null, settings: AppSettings) {
  if (!lokasi) return null;
  return settings.locationMappings.find((row) => same(row.lokasiGudang, lokasi)) ?? null;
}

export function encodeBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value);
  return params.toString();
}

export function invoiceUrl(host: string): string {
  return `${host.replace(/\/$/, "")}${SALES_INVOICE_PATH}`;
}

/**
 * One Accurate sales invoice for one Jubelio order.
 * Harga Jual on the staging row is the gross line amount, so unitPrice = Harga Jual / Qty.
 * itemCashDiscount is the line discount (Total Diskon), matching Accurate's line cash discount.
 */
export function buildInvoice(
  lines: SalesLine[],
  settings: AppSettings,
  reportDate: string,
  endpoint = `{host}${SALES_INVOICE_PATH}`,
): InvoiceDraft {
  const first = lines[0];
  const noPesanan = first?.noPesanan ?? "";
  const warnings: string[] = [];
  const reasons: string[] = [];
  const customer = first ? resolveCustomer(first, settings) : null;
  if (!lines.length) reasons.push("Pesanan tidak punya baris.");
  if (lines.length && !customer) {
    reasons.push(`Pelanggan Accurate belum dipetakan untuk channel "${first?.channel ?? ""}" / toko "${first?.namaToko ?? ""}".`);
  }

  const branches = new Set<string>();
  for (const line of lines) {
    const location = resolveLocation(line.lokasiGudang, settings);
    if (location?.branchName) branches.add(location.branchName);
    if (line.missingWeight || line.hargaJual == null || line.totalDiskon == null) {
      reasons.push(`Bobot bundle tidak ada untuk ${line.bundleKey || line.sku}.`);
    }
    if (!line.sku) reasons.push("Ada baris tanpa SKU.");
    if (!(line.qty > 0)) reasons.push(`Qty SKU ${line.sku || "—"} tidak valid.`);
    if (settings.requireWarehouse && !location?.warehouseName) {
      reasons.push(`Gudang belum dipetakan untuk lokasi "${line.lokasiGudang || "kosong"}".`);
    } else if (!location?.warehouseName && line.lokasiGudang) {
      warnings.push(`Lokasi "${line.lokasiGudang}" belum punya nama gudang Accurate.`);
    }
  }
  if (branches.size > 1) {
    warnings.push(`Pesanan memuat lebih dari satu cabang (${[...branches].join(", ")}). Header memakai cabang pertama.`);
  }

  const branchName = [...branches][0] ?? "";
  const tanggal = lines.map((line) => line.tanggal).find(Boolean) ?? null;
  const fields: Record<string, string> = {};
  if (customer?.customerNo) fields.customerNo = customer.customerNo;
  fields.transDate = accurateDate(tanggal, reportDate);
  fields.description = `Jubelio ${noPesanan}`.slice(0, 500);
  if (branchName) fields.branchName = branchName;

  lines.forEach((line, index) => {
    const location = resolveLocation(line.lokasiGudang, settings);
    const unitPrice = line.qty > 0 && line.hargaJual != null ? line.hargaJual / line.qty : 0;
    fields[`detailItem[${index}].itemNo`] = line.sku;
    fields[`detailItem[${index}].quantity`] = formatDecimal(line.qty, 4);
    fields[`detailItem[${index}].unitPrice`] = formatDecimal(unitPrice);
    fields[`detailItem[${index}].itemCashDiscount`] = formatDecimal(line.totalDiskon ?? 0);
    if (location?.warehouseName) fields[`detailItem[${index}].warehouseName`] = location.warehouseName;
  });

  const gross = lines.reduce((sum, line) => sum + (line.hargaJual ?? 0), 0);
  const discount = lines.reduce((sum, line) => sum + (line.totalDiskon ?? 0), 0);
  const uniqueReasons = [...new Set(reasons)];
  return {
    noPesanan,
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
    blockedReason: uniqueReasons.length ? uniqueReasons.join(" ") : null,
    customerName: customer?.customerName ?? null,
    gross,
    discount,
    net: gross - discount,
  };
}
