import { describe, expect, it } from "vitest";
import { buildInvoice, invoiceListQuery, readExistingInvoice } from "@/lib/accurate/invoice";
import { defaultSettings } from "@/lib/db/defaults";
import type { OrderVersion } from "@/lib/db/types";

function version(patch: Partial<OrderVersion> = {}): OrderVersion {
  return {
    id: "v",
    noPesanan: "261026K5CE6NNP",
    versionNo: 1,
    importId: null,
    source: "import_clean",
    createdAt: "2026-10-26T00:00:00.000Z",
    createdBy: null,
    isCurrent: true,
    tanggal: "2026-10-26T03:17:29",
    day: "2026-10-26",
    channel: "Shopee",
    storeName: "Jansen Official Store",
    customerName: "Elops",
    customerCode: "ELO",
    province: "Jawa Timur",
    city: "Kota Surabaya",
    kurir: "SPX",
    status: "SHIPPED",
    lokasiGudang: "Lintas Sby",
    totalNilaiPesanan: 275000,
    totalDiskon: 8000,
    qty: 16,
    revenue: 267000,
    lines: [
      {
        id: "l",
        sku: "FLMFDX003LS",
        productName: "Flimty",
        qty: 16,
        unitPrice: 17187.5,
        subTotal: 275000,
        unitDiskon: 500,
        revenuePerUnit: 16687.5,
        missingWeight: false,
        bundleKey: null,
        unitCogs: null,
        flags: [],
      },
    ],
    ...patch,
  };
}

describe("buildInvoice", () => {
  it("sends unit price per piece and itemCashDiscount as unit diskon times qty", () => {
    const draft = buildInvoice(version(), defaultSettings(), null, undefined, { customerNo: "C-ELOPS", customerName: "Elops" });
    expect(draft.blockedReason).toBeNull();
    expect(draft.fields.customerNo).toBe("C-ELOPS");
    expect(draft.customerName).toBe("Elops");
    expect(draft.fields.transDate).toBe("26/10/2026");
    expect(draft.fields.branchName).toBe("Lintas Surabaya");
    expect(draft.fields["detailItem[0].itemNo"]).toBe("FLMFDX003LS");
    expect(draft.fields["detailItem[0].quantity"]).toBe("16");
    expect(draft.fields["detailItem[0].unitPrice"]).toBe("17187.5");
    expect(draft.fields["detailItem[0].itemCashDiscount"]).toBe("8000");
    expect(draft.fields["detailItem[0].warehouseName"]).toBe("Gudang Lintas Surabaya");
    expect(draft.action).toBe("create");
  });

  it("updates an existing invoice when Accurate already has an id", () => {
    const draft = buildInvoice(version(), defaultSettings(), "99");
    expect(draft.fields.id).toBe("99");
    expect(draft.action).toBe("update");
  });

  it("uses the buyer name and ignores channel customer mappings", () => {
    const unresolved = buildInvoice(version(), defaultSettings());
    expect(unresolved.fields.customerNo).toBeUndefined();
    expect(unresolved.blockedReason).toMatch(/Elops/);
    expect(unresolved.blockedReason).not.toMatch(/SHOPEE/);
  });

  it("falls back to the default customer only when the buyer name is empty", () => {
    const draft = buildInvoice(version({ customerName: "  " }), defaultSettings());
    expect(draft.blockedReason).toBeNull();
    expect(draft.fields.customerNo).toBe("UMUM");
    expect(draft.customerName).toBe("Pelanggan Umum");
  });

  it("sends the order number as the invoice number and marks prices as PPN-inclusive", () => {
    const current = version({
      noPesanan: "261116DDSHB0GM",
      totalNilaiPesanan: 51900,
      totalDiskon: 0,
      revenue: 51900,
      qty: 1,
      lines: [{
        ...version().lines[0],
        qty: 1,
        unitPrice: 51900,
        subTotal: 51900,
        unitDiskon: 0,
        revenuePerUnit: 51900,
      }],
    });
    const draft = buildInvoice(current, defaultSettings(), null, undefined, { customerNo: "C-1", customerName: "Elops" });
    expect(draft.blockedReason).toBeNull();
    expect(draft.action).toBe("create");
    expect(draft.fields.number).toBe("261116DDSHB0GM");
    expect(draft.fields.typeAutoNumber).toBeUndefined();
    expect(draft.body).not.toContain("typeAutoNumber");
    expect(draft.fields.taxable).toBe("true");
    expect(draft.fields.inclusiveTax).toBe("true");
    expect(draft.fields["detailItem[0].useTax1"]).toBe("true");
    expect(draft.fields["detailItem[0].useTax2"]).toBe("false");
    expect(draft.fields["detailItem[0].useTax3"]).toBe("false");
    expect(draft.fields["detailItem[0].unitPrice"]).toBe("51900");
    expect(draft.net).toBe(51900);
  });

  it("keeps the same invoice number when updating an existing Accurate id", () => {
    const draft = buildInvoice(version(), defaultSettings(), "99", undefined, { customerNo: "C-ELOPS", customerName: "Elops" });
    expect(draft.action).toBe("update");
    expect(draft.fields.id).toBe("99");
    expect(draft.fields.number).toBe("261026K5CE6NNP");
    expect(draft.fields.taxable).toBe("true");
    expect(draft.fields.inclusiveTax).toBe("true");
    expect(draft.fields.typeAutoNumber).toBeUndefined();
  });

  it("refuses an order number longer than Accurate's transaction number", () => {
    const draft = buildInvoice(version({ noPesanan: "N".repeat(51) }), defaultSettings(), null, undefined, { customerNo: "C-1", customerName: "Elops" });
    expect(draft.fields.number).toBeUndefined();
    expect(draft.fields.typeAutoNumber).toBeUndefined();
    expect(draft.blockedReason).toMatch(/terlalu panjang/);
    expect(draft.blockedReason).toMatch(/51 karakter, maksimal 50/);
  });

  it("reads an existing invoice by exact number from detail or list", () => {
    expect(invoiceListQuery("261116DDSHB0GM")).toContain("filter.number.op=EQUAL");
    expect(invoiceListQuery("261116DDSHB0GM")).toContain("filter.number.val=261116DDSHB0GM");
    expect(readExistingInvoice({ s: true, d: { id: 42, number: "261116DDSHB0GM" } }, "261116DDSHB0GM")).toEqual({
      id: "42",
      number: "261116DDSHB0GM",
    });
    expect(readExistingInvoice({ s: true, d: [{ id: 7, no: "261116DDSHB0GM" }, { id: 8, number: "LAIN" }] }, "261116DDSHB0GM")).toEqual({
      id: "7",
      number: "261116DDSHB0GM",
    });
    expect(readExistingInvoice({ s: true, d: [{ id: 8, number: "LAIN" }] }, "261116DDSHB0GM")).toBeNull();
    expect(readExistingInvoice({ s: false, d: ["Data tidak ditemukan"] }, "261116DDSHB0GM")).toBeNull();
    expect(() => readExistingInvoice({ s: false, d: ["Database terkunci"] }, "261116DDSHB0GM")).toThrow(/terkunci/);
  });

  it("blocks a line whose bundle weight is missing", () => {
    const current = version();
    current.lines = [{ ...current.lines[0], missingWeight: true, unitPrice: null, unitDiskon: null, bundleKey: "BDL-ITEM" }];
    const draft = buildInvoice(current, defaultSettings());
    expect(draft.blockedReason).toMatch(/Bobot bundle tidak ada/);
  });
});
