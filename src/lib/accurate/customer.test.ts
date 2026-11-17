import { describe, expect, it, vi } from "vitest";
import { ACCURATE_SCOPE } from "@/lib/accurate/client";
import {
  buyerName,
  customerListQuery,
  customerNoRequired,
  deterministicCustomerNo,
  missingCustomerScopes,
  normalizeCustomerKey,
  readCustomerHits,
  readSavedCustomer,
  resolveBuyerCustomer,
  selectExactCustomer,
} from "@/lib/accurate/customer";

describe("Accurate customer identity", () => {
  it("normalizes the buyer name and builds a stable customer number", () => {
    expect(buyerName("  Budi   Santoso ")).toBe("Budi Santoso");
    expect(normalizeCustomerKey("  Budi   Santoso ")).toBe("budi santoso");
    expect(deterministicCustomerNo("Budi Santoso")).toBe(deterministicCustomerNo("  budi   santoso "));
    expect(deterministicCustomerNo("Budi Santoso")).not.toBe(deterministicCustomerNo("Ani"));
    expect(deterministicCustomerNo("Budi Santoso").length).toBeLessThanOrEqual(30);
  });

  it("asks Accurate for an exact keyword match, then a name match", () => {
    expect(customerListQuery("Budi", "keywords")).toContain("filter.keywords.op=EQUAL");
    expect(customerListQuery("Budi", "keywords")).toContain("filter.keywords.val=Budi");
    expect(customerListQuery("Budi", "name")).toContain("filter.name.op=EQUAL");
    expect(customerListQuery("Budi", "name")).toContain("filter.name.val=Budi");
  });

  it("reads list and save payloads without treating a partial name as a match", () => {
    const hits = readCustomerHits({
      s: true,
      d: [
        { id: 1, name: "Budi Santoso", no: "C.0001" },
        { id: 2, name: "Budi", customerNo: "C.0002" },
        { id: 3, name: "Budi", no: "C.0009" },
      ],
    });
    expect(selectExactCustomer(hits, "budi")?.hit.customerNo).toBe("C.0002");
    expect(selectExactCustomer(hits, "budi")?.ambiguous).toBe(true);
    expect(selectExactCustomer(hits, "Tidak Ada")).toBeNull();
    expect(readCustomerHits({ s: false, d: ["Tidak ada data"] })).toEqual([]);
    expect(readSavedCustomer({ s: true, r: { id: 9, no: "C.0010", name: "Sari" } }, "Sari").customerNo).toBe("C.0010");
    expect(customerNoRequired("Nomor pelanggan harus diisi")).toBe(true);
    expect(customerNoRequired("Gudang tidak ditemukan")).toBe(false);
  });

  it("uses the cache, then an exact Accurate hit, then creates, and falls back only without a name", async () => {
    const lookup = vi.fn(async () => [{ id: "4", name: "Sari", customerNo: "C.0004" }]);
    const create = vi.fn(async () => ({ id: "8", name: "Dewi", customerNo: "C.0008" }));
    const cached = await resolveBuyerCustomer({
      buyerName: "Sari",
      defaultCustomerNo: "UMUM",
      defaultCustomerName: "Pelanggan Umum",
      cached: { customerNo: "C.CACHE", name: "Sari" },
      lookup,
      create,
    });
    expect(cached.customerNo).toBe("C.CACHE");
    expect(cached.log).toBeNull();
    expect(lookup).not.toHaveBeenCalled();

    const found = await resolveBuyerCustomer({
      buyerName: "Sari",
      defaultCustomerNo: "UMUM",
      defaultCustomerName: "Pelanggan Umum",
      cached: null,
      lookup,
      create,
    });
    expect(found.customerNo).toBe("C.0004");
    expect(found.log).toMatch(/ditemukan: Sari → C\.0004/);
    expect(found.cache?.nameKey).toBe("sari");

    const created = await resolveBuyerCustomer({
      buyerName: "Dewi",
      defaultCustomerNo: "UMUM",
      defaultCustomerName: "Pelanggan Umum",
      cached: null,
      lookup: async () => [],
      create,
    });
    expect(created.log).toMatch(/dibuat: Dewi → C\.0008/);
    expect(create).toHaveBeenCalledWith("Dewi");

    const fallback = await resolveBuyerCustomer({
      buyerName: "   ",
      defaultCustomerNo: "UMUM",
      defaultCustomerName: "Pelanggan Umum",
      cached: null,
      lookup,
      create,
    });
    expect(fallback.customerNo).toBe("UMUM");
    expect(fallback.log).toMatch(/pelanggan default UMUM/);
    expect(fallback.cache).toBeNull();
  });

  it("requests customer scopes on the Accurate authorize URL", () => {
    expect(missingCustomerScopes(null)).toEqual(["customer_view", "customer_save"]);
    expect(missingCustomerScopes("sales_invoice_view sales_invoice_save")).toEqual(["customer_view", "customer_save"]);
    expect(missingCustomerScopes(ACCURATE_SCOPE)).toEqual([]);
    expect(ACCURATE_SCOPE).toContain("warehouse_view");
    expect(ACCURATE_SCOPE).toContain("branch_view");
    expect(ACCURATE_SCOPE).toContain("sales_invoice_save");
  });
});
