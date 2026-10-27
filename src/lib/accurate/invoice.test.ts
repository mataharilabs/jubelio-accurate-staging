import { describe, expect, it } from "vitest";
import { buildInvoice } from "@/lib/accurate/invoice";
import { defaultSettings } from "@/lib/db/defaults";
import type { SalesLine } from "@/lib/db/types";

function line(patch: Partial<SalesLine> = {}): SalesLine {
  return {
    id: "1",
    batchId: "b",
    rowIndex: 0,
    noPesanan: "586791043510469959",
    noPesananSumber: "TT-1",
    channel: "Shop | Tokopedia",
    sku: "NTMVTD002L",
    qty: 2,
    hargaJual: 170000,
    totalDiskon: 58284,
    tanggal: null,
    lokasiGudang: "Lintas Jkt",
    namaToko: "Jansen Official Store",
    status: "SHIPPED",
    namaBarang: "Nutrimax",
    sourceSku: "NTM-D34000-2BT",
    isBundle: true,
    bundleKey: "NTM-D34000-2BT-NTMVTD002L",
    bobot: 0.5,
    missingWeight: false,
    isShopee: false,
    syncStatus: "belum",
    sourceQty: 1,
    sourceHarga: 340000,
    sourceTotalPenjualan: 223432,
    sourceDiskon: 116568,
    sourceDiskonLainnya: 0,
    sourceBiayaLainnya: 0,
    sourceQtyBundle: 2,
    ...patch,
  };
}

describe("buildInvoice", () => {
  it("builds the Accurate sales invoice fields from a cleaned row", () => {
    const draft = buildInvoice([line()], defaultSettings(), "2026-10-26");
    expect(draft.blockedReason).toBeNull();
    expect(draft.fields.customerNo).toBe("TOKOPEDIA");
    expect(draft.fields.branchName).toBe("Lintas Jakarta");
    expect(draft.fields.transDate).toBe("26/10/2026");
    expect(draft.fields["detailItem[0].itemNo"]).toBe("NTMVTD002L");
    expect(draft.fields["detailItem[0].quantity"]).toBe("2");
    expect(draft.fields["detailItem[0].unitPrice"]).toBe("85000");
    expect(draft.fields["detailItem[0].itemCashDiscount"]).toBe("58284");
    expect(draft.fields["detailItem[0].warehouseName"]).toBe("Gudang Lintas Jakarta");
    expect(draft.body).toContain("detailItem%5B0%5D.itemNo=NTMVTD002L");
    expect(draft.endpoint).toBe("{host}/accurate/api/sales-invoice/save.do");
  });

  it("blocks a bundle row whose weight is missing", () => {
    const draft = buildInvoice(
      [line({ missingWeight: true, hargaJual: null, totalDiskon: null, bundleKey: "BDL-ITEM" })],
      defaultSettings(),
      "2026-10-26",
    );
    expect(draft.blockedReason).toMatch(/Bobot bundle tidak ada/);
  });

  it("uses Shopee line gross divided by quantity as unitPrice", () => {
    const draft = buildInvoice(
      [line({ channel: "SHOPEE", isShopee: true, qty: 16, hargaJual: 17187.5, totalDiskon: 0, sku: "FLMFDX003LS", lokasiGudang: "Lintas Sby" })],
      defaultSettings(),
      "2026-10-26",
    );
    expect(draft.fields.customerNo).toBe("SHOPEE");
    expect(draft.fields["detailItem[0].unitPrice"]).toBe("1074.21875");
    expect(draft.fields["detailItem[0].warehouseName"]).toBe("Gudang Lintas Surabaya");
    expect(draft.blockedReason).toBeNull();
  });
});
