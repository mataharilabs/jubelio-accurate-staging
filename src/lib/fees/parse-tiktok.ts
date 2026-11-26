import { costFromDeduction, parseAmount } from "@/lib/fees/money";
import { cell, findHeader, sheetMatrix, textCell } from "@/lib/fees/sheets";
import { SETTLEMENT_MARKER, reducesProfit, type FeeDraft, type FeeGroup, type ParsedFees } from "@/lib/fees/types";
import type * as XLSX from "xlsx";

/** Ongkir is the net seller shipping and already includes Biaya layanan logistik on almost every order. */
const COLUMNS: { name: string; group: FeeGroup }[] = [
  { name: "Biaya komisi platform", group: "Komisi" },
  { name: "Komisi dinamis", group: "Komisi" },
  { name: "Biaya layanan pre-order", group: "Biaya layanan/program" },
  { name: "Biaya layanan Mall", group: "Biaya layanan/program" },
  { name: "Biaya layanan Program Bebas Ongkir", group: "Biaya layanan/program" },
  { name: "Biaya layanan Program Growth Xtra", group: "Biaya layanan/program" },
  { name: "Biaya layanan Khusus LIVE", group: "Biaya layanan/program" },
  { name: "Biaya layanan Growth Xtra Program Super", group: "Biaya layanan/program" },
  { name: "Biaya layanan Program EAMS", group: "Biaya layanan/program" },
  { name: "Biaya layanan Brands Crazy Deal/Flash Sale", group: "Biaya layanan/program" },
  { name: "Biaya Dilayani Tokopedia", group: "Biaya layanan/program" },
  { name: "Biaya penanganan Dilayani Tokopedia", group: "Biaya layanan/program" },
  { name: "Biaya program PayLater", group: "Biaya layanan/program" },
  { name: "Biaya sumber daya campaign", group: "Biaya layanan/program" },
  { name: "Biaya layanan penginstalan", group: "Biaya layanan/program" },
  { name: "Biaya layanan khusus platform", group: "Biaya layanan/program" },
  { name: "Program layanan terkelola (Biaya per pesanan)", group: "Biaya layanan/program" },
  { name: "Biaya produk sesuai jarak dari Program Horison+", group: "Biaya layanan/program" },
  { name: "Biaya Pembayaran", group: "Biaya pembayaran" },
  { name: "Credit card installment - Handling fee", group: "Biaya pembayaran" },
  { name: "Biaya pemrosesan pesanan", group: "Biaya proses pesanan" },
  { name: "Ongkir", group: "Ongkir ditanggung penjual" },
  { name: "Ongkir pesanan gagal kirim", group: "Ongkir ditanggung penjual" },
  { name: "Komisi Afiliasi", group: "Komisi afiliasi" },
  { name: "Komisi mitra afiliasi", group: "Komisi afiliasi" },
  { name: "Komisi Iklan Toko afiliasi", group: "Komisi afiliasi" },
  { name: "Komisi iklan toko Mitra Afiliasi", group: "Komisi afiliasi" },
  { name: "Deposit komisi afiliasi", group: "Komisi afiliasi" },
  { name: "Pengembalian dana komisi afiliasi", group: "Komisi afiliasi" },
  { name: "PPh Pasal 22 dipungut", group: "Pajak" },
  { name: "Program layanan terkelola (Pajak penjualan)", group: "Pajak" },
  { name: "Pajak penjualan atas voucher GMV Max", group: "Pajak" },
  { name: "Biaya iklan GMV Max", group: "Lain-lain" },
  { name: "Voucher GMV Max", group: "Lain-lain" },
  { name: "Biaya asuransi", group: "Lain-lain" },
  { name: "Penggantian biaya asuransi", group: "Lain-lain" },
];

function orderId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value) ? String(value) : value.toFixed(0);
  }
  return String(value ?? "").trim();
}

/** TikTok Shop settlement, including Tokopedia rows in the same file. Order-level only. */
export function parseTiktok(book: XLSX.WorkBook): ParsedFees {
  const matrix = sheetMatrix(book, "Detail pesanan");
  const header = findHeader(matrix, ["ID Pesanan/Penyesuaian", "Jenis transaksi", "Ongkir", "Biaya komisi platform"]);
  if (!header) throw new Error("Sheet Detail pesanan tidak dikenali.");
  const columns = header.columns;
  const rows: FeeDraft[] = [];
  const orders: { noPesanan: string }[] = [];
  let readCount = 0;
  for (let index = header.index + 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    if (textCell(values, columns, "Jenis transaksi") !== "Pesanan") continue;
    const no = orderId(cell(values, columns, "ID Pesanan/Penyesuaian"));
    if (!no || no === "ID Pesanan/Penyesuaian") continue;
    readCount += 1;
    orders.push({ noPesanan: no });
    let emitted = 0;
    for (const column of COLUMNS) {
      const amount = costFromDeduction(parseAmount(cell(values, columns, column.name)));
      if (Math.abs(amount) < 0.005) continue;
      emitted += 1;
      rows.push({
        noPesanan: no,
        sku: null,
        feeGroup: column.group,
        feeName: column.name,
        amountRp: amount,
        pct: null,
        base: null,
        reducesProfit: reducesProfit(column.group),
        allocated: false,
        marketplace: "tiktok",
      });
    }
    if (!emitted) {
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
        marketplace: "tiktok",
      });
    }
  }
  return { marketplace: "tiktok", format: "settlement", rows, orders, readCount };
}
