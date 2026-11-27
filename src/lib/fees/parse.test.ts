import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { allocateOrderFees, splitAmount } from "@/lib/fees/allocate";
import { chunkFeeRows, keepMatched } from "@/lib/fees/chunk";
import { extendedHpp } from "@/lib/fees/money";
import { parseFeeWorkbook, summarizeFees } from "@/lib/fees/parse";
import { cell, findHeader, sheetMatrix } from "@/lib/fees/sheets";
import { SETTLEMENT_MARKER, type FeeDraft } from "@/lib/fees/types";

function book(name: string): XLSX.WorkBook {
  const file = path.join(process.cwd(), "src/lib/fees/fixtures", name);
  return XLSX.read(readFileSync(file), { type: "buffer" });
}

function sum(rows: FeeDraft[], group?: FeeDraft["feeGroup"]): number {
  return rows.filter((row) => !group || row.feeGroup === group).reduce((total, row) => total + row.amountRp, 0);
}

describe("marketplace fee parsers", () => {
  it("parses Shopee SKU rows without doubling order rows or charging pass-through shipping", () => {
    const workbook = book("shopee-penghasilan.xlsx");
    const matrix = sheetMatrix(workbook, "Penghasilan");
    const header = findHeader(matrix, ["Username (Pembeli)"]);
    expect(header).toBeTruthy();
    for (let index = (header?.index ?? 0) + 1; index < matrix.length; index += 1) {
      expect(String(cell(matrix[index] ?? [], header!.columns, "Username (Pembeli)") ?? "")).toBe("");
    }
    const parsed = parseFeeWorkbook(workbook);
    expect(parsed.marketplace).toBe("shopee");
    expect(parsed.orders).toHaveLength(17);
    const admin = parsed.rows.filter((row) => row.feeName === "Biaya Administrasi");
    expect(admin).toHaveLength(19);
    expect(sum(parsed.rows, "Komisi")).toBe(87676);
    expect(sum(parsed.rows, "Biaya proses pesanan")).toBe(21250);
    expect(sum(parsed.rows, "Biaya layanan/program")).toBe(44147);
    expect(sum(parsed.rows, "Pajak")).toBe(2489);
    expect(parsed.rows.filter((row) => row.feeGroup === "Pajak").every((row) => !row.reducesProfit)).toBe(true);
    expect(sum(parsed.rows, "Ongkir ditanggung penjual")).toBe(0);
    const first = admin.find((row) => row.noPesanan === "2611015H350RJH");
    expect(first).toMatchObject({ amountRp: 3591, pct: 9, base: "Harga Produk", sku: null, productName: expect.stringContaining("MAXAM") });
    const split = parsed.rows.filter((row) => row.noPesanan === "26092516A3B4MU" && row.feeName === "Biaya Administrasi");
    expect(split.map((row) => row.amountRp).sort((a, b) => a - b)).toEqual([1161, 1161]);
    expect(parsed.rows.some((row) => row.feeName === "Voucher disponsor oleh Penjual")).toBe(false);
  });

  it("parses Lazada fee lines as VAT-inclusive costs and skips item price", () => {
    const parsed = parseFeeWorkbook(book("lazada-transaction.xlsx"));
    expect(parsed.marketplace).toBe("lazada");
    expect(parsed.orders).toHaveLength(11);
    const order = parsed.rows.filter((row) => row.noPesanan === "2704840771640531");
    expect(order.find((row) => row.feeName === "Commission")).toMatchObject({ amountRp: 3850, sku: "MRI001001L-10", feeGroup: "Komisi", base: "Item Price Credit" });
    expect(order.find((row) => row.feeName === "Payment Fee")?.amountRp).toBe(910);
    expect(order.find((row) => row.feeName === "Free Shipping Max Fee")?.feeGroup).toBe("Biaya layanan/program");
    expect(order.find((row) => row.feeName === "SPA program Fee")?.amountRp).toBe(1942);
    expect(order.find((row) => row.feeName === "Order Processing Fee")).toMatchObject({ amountRp: 1250, feeGroup: "Biaya proses pesanan" });
    expect(order.find((row) => row.feeName === "Withholding tax - PIT")).toMatchObject({ amountRp: 250, reducesProfit: false, feeGroup: "Pajak" });
    expect(order.some((row) => row.feeName === "Item Price Credit")).toBe(false);
    expect(order.find((row) => row.feeName === "Commission")?.pct).toBeCloseTo(7.7, 1);
  });

  it("parses TikTok and Tokopedia order rows, using Ongkir once and keeping zero-fee settlements", () => {
    const parsed = parseFeeWorkbook(book("tiktok-settlement.xlsx"));
    expect(parsed.marketplace).toBe("tiktok");
    expect(parsed.orders.map((order) => order.noPesanan)).not.toContain("7706179217035413268");
    const zero = parsed.rows.filter((row) => row.noPesanan === "587351639263774648");
    expect(zero).toEqual([expect.objectContaining({ feeName: SETTLEMENT_MARKER, amountRp: 0, reducesProfit: false })]);
    const mismatch = parsed.rows.filter((row) => row.noPesanan === "587099108027041673");
    expect(mismatch.some((row) => row.feeName === "Biaya layanan logistik")).toBe(false);
    expect(mismatch.filter((row) => row.feeName === "Ongkir")).toEqual([expect.objectContaining({ amountRp: 12000, feeGroup: "Ongkir ditanggung penjual" })]);
    expect(sum(mismatch, "Komisi")).toBe(28900 + 37570);
    expect(mismatch.find((row) => row.feeGroup === "Pajak")).toMatchObject({ amountRp: 2604, reducesProfit: false });
    const affiliate = parsed.rows.find((row) => row.noPesanan === "587289235429361001" && row.feeGroup === "Komisi afiliasi");
    expect(affiliate).toMatchObject({ feeName: "Komisi Afiliasi", amountRp: 2398, sku: null, allocated: false });
    expect(parsed.rows.filter((row) => row.noPesanan === "587289235429361001" && row.feeName === "Ongkir")).toHaveLength(1);
    expect(parsed.rows.find((row) => row.feeName === "Komisi Iklan Toko afiliasi")?.feeGroup).toBe("Komisi afiliasi");
    expect(summarizeFees(parsed.rows).orders).toBe(parsed.orders.length);
  });

  it("parses Blibli per order item and keeps PPh out of profit", () => {
    const parsed = parseFeeWorkbook(book("blibli-ssr.xlsx"));
    expect(parsed.marketplace).toBe("blibli");
    expect(parsed.orders).toEqual([{ noPesanan: "12199979402-12276826190", orderId: "12199979402" }]);
    const rows = parsed.rows.filter((row) => row.noPesanan === "12199979402-12276826190");
    expect(rows.find((row) => row.feeName === "Regular Margin")).toMatchObject({ amountRp: 9264, feeGroup: "Komisi", sku: "40100083" });
    expect(rows.find((row) => row.feeName === "Add On Margin")).toMatchObject({ amountRp: 4053, feeGroup: "Biaya layanan/program" });
    expect(rows.find((row) => row.feeName.includes("PPh 22"))).toMatchObject({ amountRp: 522, feeGroup: "Pajak", reducesProfit: false, sku: "40100083" });
    expect(rows.some((row) => /promo seller/i.test(row.feeName))).toBe(false);
    expect(rows.some((row) => row.feeName === "Total Margin")).toBe(false);
  });

  it("parses the standard template and rejects an unknown group", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["no_pesanan", "sku", "grup_biaya", "nama_biaya", "nominal", "persen"],
      ["ABC1", "SKU-1", "Komisi", "Komisi toko", 1500, 9],
      ["ABC1", "", "Pajak", "PPh 22", 100, ""],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Biaya");
    const parsed = parseFeeWorkbook(workbook);
    expect(parsed.marketplace).toBe("template");
    expect(parsed.rows[0]).toMatchObject({ sku: "SKU-1", amountRp: 1500, pct: 9, reducesProfit: true });
    expect(parsed.rows[1]).toMatchObject({ sku: null, reducesProfit: false, feeGroup: "Pajak" });
    const bad = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(bad, XLSX.utils.aoa_to_sheet([
      ["no_pesanan", "nominal", "grup_biaya"],
      ["ABC", 10, "Bukan biaya"],
    ]), "Biaya");
    expect(() => parseFeeWorkbook(bad)).toThrow(/Grup biaya/);
  });

  it("reads a Pembayaran sheet on its own and beside the fee template", () => {
    const only = XLSX.read(readFileSync(path.join(process.cwd(), "src/lib/fees/fixtures/pembayaran-only.xlsx")), { type: "buffer" });
    const parsed = parseFeeWorkbook(only);
    expect(parsed.rows).toEqual([]);
    expect(parsed.payments).toEqual([
      { noPesanan: "WEB-1001", paidAt: "2026-11-01", amountRp: 250000, method: "Transfer", note: "Pelunasan" },
      { noPesanan: "POS-9", paidAt: "2026-11-02", amountRp: 10000, method: "", note: "" },
    ]);
    const both = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(both, XLSX.utils.aoa_to_sheet([
      ["no_pesanan", "sku", "grup_biaya", "nama_biaya", "nominal", "persen"],
      ["WEB-1001", "", "Komisi", "Komisi", 500, ""],
    ]), "Biaya");
    XLSX.utils.book_append_sheet(both, XLSX.utils.aoa_to_sheet([
      ["no_pesanan", "tanggal_bayar", "nominal", "metode", "catatan"],
      ["WEB-1001", "2026-11-03", 9000, "Tunai", ""],
    ]), "Pembayaran");
    const mixed = parseFeeWorkbook(both);
    expect(mixed.rows).toHaveLength(1);
    expect(mixed.payments?.[0]).toMatchObject({ noPesanan: "WEB-1001", amountRp: 9000, paidAt: "2026-11-03" });
    expect(mixed.orders.map((order) => order.noPesanan)).toContain("WEB-1001");
  });
});

describe("fee allocation", () => {
  it("spreads an order fee by sales share and keeps the total", () => {
    const rows = allocateOrderFees([
      { noPesanan: "1", sku: null, feeGroup: "Komisi", feeName: "Komisi", amountRp: 100, pct: null, base: null, reducesProfit: true, allocated: false, marketplace: "tiktok" },
      { noPesanan: "1", sku: null, feeGroup: "Lain-lain", feeName: SETTLEMENT_MARKER, amountRp: 0, pct: null, base: null, reducesProfit: false, allocated: false, marketplace: "tiktok" },
    ], [
      { noPesanan: "1", sku: "B", productName: "B", revenue: 25, qty: 1 },
      { noPesanan: "1", sku: "A", productName: "A", revenue: 75, qty: 1 },
    ]);
    const costs = rows.filter((row) => row.feeName === "Komisi");
    expect(costs.map((row) => [row.sku, row.amountRp, row.allocated])).toEqual([["A", 75, true], ["B", 25, true]]);
    expect(rows.find((row) => row.feeName === SETTLEMENT_MARKER)?.sku).toBeNull();
    expect(splitAmount(100, [1, 1, 1])).toEqual([33.33, 33.33, 33.34]);
  });

  it("keeps an order inside one save chunk and drops orders that were not found", () => {
    const row = (noPesanan: string): FeeDraft => ({
      noPesanan, sku: null, feeGroup: "Komisi", feeName: "Komisi", amountRp: 10, pct: null, base: null, reducesProfit: true, allocated: false, marketplace: "shopee",
    });
    const chunks = chunkFeeRows([row("A"), row("A"), row("B")], 1);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2);
    expect(keepMatched([row("A"), row("B")], [{ input: "B", resolved: "B-1" }]).map((item) => item.noPesanan)).toEqual(["B-1"]);
  });

  it("values missing HPP as zero and DPP times 1.11 otherwise", () => {
    expect(extendedHpp(null, 4)).toBe(0);
    expect(extendedHpp(1000, 2)).toBe(Math.round(1000 * 1.11) * 2);
  });
});
