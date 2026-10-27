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

  it("keeps Accurate unitPrice as the allocated line amount divided by output qty", () => {
    const draft = buildInvoice(
      [line({ channel: "SHOPEE", isShopee: true, qty: 16, hargaJual: 17187.5, sourceQty: 1, totalDiskon: 0, sku: "FLMFDX003LS", lokasiGudang: "Lintas Sby" })],
      defaultSettings(),
      "2026-10-26",
    );
    expect(buildInvoice([line({ tanggal: "2026-10-26T19:34:29.000Z", channel: "SHOPEE" })], defaultSettings(), "2026-10-26").fields.transDate).toBe("26/10/2026");
    expect(draft.fields.customerNo).toBe("SHOPEE");
    expect(draft.fields["detailItem[0].unitPrice"]).toBe("1074.21875");
    expect(draft.fields["detailItem[0].quantity"]).toBe("16");
    expect(draft.fields["detailItem[0].warehouseName"]).toBe("Gudang Lintas Surabaya");
    expect(draft.blockedReason).toBeNull();

    const single = buildInvoice(
      [line({ channel: "SHOPEE", isShopee: true, isBundle: false, qty: 2, sourceQty: 2, hargaJual: 180000, totalDiskon: 0, sku: "NTMKCL001L", lokasiGudang: "Lintas Sby" })],
      defaultSettings(),
      "2026-10-26",
    );
    expect(single.fields["detailItem[0].unitPrice"]).toBe("180000");
    expect(single.fields["detailItem[0].quantity"]).toBe("2");

    const bundle = buildInvoice(
      [line({ channel: "SHOPEE", isShopee: true, isBundle: true, qty: 8, sourceQty: 2, sourceQtyBundle: 4, hargaJual: 14500, totalDiskon: 0, sku: "40100083-01", lokasiGudang: "Lintas Sby" })],
      defaultSettings(),
      "2026-10-26",
    );
    expect(bundle.fields["detailItem[0].unitPrice"]).toBe("3625");
    expect(bundle.fields["detailItem[0].quantity"]).toBe("8");

    const perPackage = buildInvoice(
      [line({ qty: 3, sourceQty: 3, isBundle: false, hargaJual: 45000, totalDiskon: 500 / 3, sku: "SKU-1" })],
      defaultSettings(),
      "2026-10-26",
    );
    expect(perPackage.fields["detailItem[0].unitPrice"]).toBe("15000");
    expect(perPackage.fields["detailItem[0].itemCashDiscount"]).toBe(String(500));
  });
});
