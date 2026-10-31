import { describe, expect, it } from "vitest";
import { buildInvoice } from "@/lib/accurate/invoice";
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
    const draft = buildInvoice(version(), defaultSettings());
    expect(draft.blockedReason).toBeNull();
    expect(draft.fields.customerNo).toBe("SHOPEE");
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

  it("blocks a line whose bundle weight is missing", () => {
    const current = version();
    current.lines = [{ ...current.lines[0], missingWeight: true, unitPrice: null, unitDiskon: null, bundleKey: "BDL-ITEM" }];
    const draft = buildInvoice(current, defaultSettings());
    expect(draft.blockedReason).toMatch(/Bobot bundle tidak ada/);
  });
});
