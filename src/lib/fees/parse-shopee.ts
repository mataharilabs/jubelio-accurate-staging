import { costFromDeduction, parseAmount, percentOf } from "@/lib/fees/money";
import { cell, findHeader, sheetMatrix, textCell } from "@/lib/fees/sheets";
import { SETTLEMENT_MARKER, reducesProfit, type FeeDraft, type ParsedFees } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

const FEE_COLUMNS: { name: string; group: FeeDraft["feeGroup"]; base?: "harga" | "pajak" }[] = [
  { name: "Biaya Administrasi", group: "Komisi", base: "harga" },
  { name: "Biaya Proses Pesanan", group: "Biaya proses pesanan" },
  { name: "Biaya Layanan Promo XTRA", group: "Biaya layanan/program", base: "harga" },
  { name: "Biaya Kampanye", group: "Biaya layanan/program" },
  { name: "Biaya Komisi AMS", group: "Komisi afiliasi" },
  { name: "Biaya Isi Saldo Otomatis (dari Penghasilan)", group: "Lain-lain" },
  { name: "Premi", group: "Lain-lain" },
  { name: "FBS Fee", group: "Lain-lain" },
  { name: "PPh 22", group: "Pajak", base: "pajak" },
];

const SHIPPING = [
  "Ongkir Dibayar Pembeli",
  "Ongkos Kirim yang Dibayarkan ke Jasa Kirim",
  "Potongan Ongkos Kirim dari Jasa Kirim",
  "Gratis Ongkir dari Shopee",
  "Ongkos Kirim Pengembalian Barang",
  "Pengembalian Biaya Kirim",
  "Promo Gratis Ongkir dari Penjual",
  "Return to Seller Fee",
];

function pushFee(rows: FeeDraft[], draft: Omit<FeeDraft, "reducesProfit" | "allocated" | "marketplace" | "pct" | "base"> & { pct?: number | null; base?: string | null }): void {
  if (Math.abs(draft.amountRp) < 0.005) return;
  rows.push({
    ...draft,
    pct: draft.pct ?? null,
    base: draft.base ?? null,
    reducesProfit: reducesProfit(draft.feeGroup),
    allocated: false,
    marketplace: "shopee",
  });
}

/** Shopee Laporan Penghasilan. SKU rows already split fees; Order rows are the same total and are skipped. */
export function parseShopee(book: XLSX.WorkBook): ParsedFees {
  const matrix = sheetMatrix(book, "Penghasilan");
  const header = findHeader(matrix, ["Lihat berdasarkan", "No. Pesanan", "Biaya Administrasi"]);
  if (!header) throw new Error("Sheet Penghasilan tidak punya kolom No. Pesanan.");
  const columns = header.columns;
  type Raw = { level: string; no: string; productId: string; productName: string; values: unknown[] };
  const raws: Raw[] = [];
  for (let index = header.index + 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const no = textCell(values, columns, "No. Pesanan");
    const level = textCell(values, columns, "Lihat berdasarkan").toLowerCase();
    if (!no || (level !== "sku" && level !== "order")) continue;
    raws.push({
      level,
      no,
      productId: textCell(values, columns, "ID Produk"),
      productName: textCell(values, columns, "Nama Produk"),
      values,
    });
  }
  const byOrder = new Map<string, Raw[]>();
  for (const row of raws) {
    const list = byOrder.get(row.no) ?? [];
    list.push(row);
    byOrder.set(row.no, list);
  }
  const rows: FeeDraft[] = [];
  for (const [no, list] of byOrder) {
    const skuRows = list.filter((row) => row.level === "sku");
    const chosen = skuRows.length ? skuRows : list.filter((row) => row.level === "order");
    for (const row of chosen) {
      const harga = parseAmount(cell(row.values, columns, "Harga Produk"));
      const pajak = parseAmount(cell(row.values, columns, "Dasar Pengenaan Pajak"));
      const productName = row.productName && row.productName !== "-" ? row.productName : undefined;
      for (const column of FEE_COLUMNS) {
        const cost = costFromDeduction(parseAmount(cell(row.values, columns, column.name)));
        const baseAmount = column.base === "harga" ? harga : column.base === "pajak" ? pajak : 0;
        pushFee(rows, {
          noPesanan: no,
          sku: null,
          productName,
          feeGroup: column.group,
          feeName: column.name,
          amountRp: cost,
          pct: baseAmount ? percentOf(cost, baseAmount) : null,
          base: column.base === "harga" ? "Harga Produk" : column.base === "pajak" ? "Dasar Pengenaan Pajak" : null,
        });
      }
      const shippingNet = SHIPPING.reduce((sum, name) => sum + parseAmount(cell(row.values, columns, name)), 0);
      const shippingCost = costFromDeduction(shippingNet);
      const onlyReturn = Math.abs(shippingCost - costFromDeduction(parseAmount(cell(row.values, columns, "Return to Seller Fee")))) < 0.005
        && Math.abs(parseAmount(cell(row.values, columns, "Return to Seller Fee"))) >= 0.005;
      pushFee(rows, {
        noPesanan: no,
        sku: null,
        productName,
        feeGroup: "Ongkir ditanggung penjual",
        feeName: onlyReturn ? "Return to Seller Fee" : "Ongkir ditanggung penjual",
        amountRp: shippingCost,
      });
    }
    if (!rows.some((item) => item.noPesanan === no)) {
      rows.push({
        noPesanan: no,
        sku: null,
        feeGroup: "Lain-lain",
        feeName: SETTLEMENT_MARKER,
        amountRp: 0,
        pct: null,
        base: null,
        reducesProfit: false,
        allocated: false,
        marketplace: "shopee",
      });
    }
  }
  return {
    marketplace: "shopee",
    format: "laporan-penghasilan",
    rows,
    orders: [...byOrder.keys()].map((noPesanan) => ({ noPesanan })),
    readCount: raws.length,
  };
}
