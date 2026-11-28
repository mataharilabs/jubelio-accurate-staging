import { describe, expect, it } from "vitest";
import { matchesOrderFilter } from "@/lib/domain/order-filter";

const row = { day: "2026-10-28", status: "RETURNED", noPesanan: "A1", sku: "SKU", productName: "Sabun", customerName: "Ani", storeName: "Toko", city: "Bandung", channel: "Shopee" };

describe("order list filters", () => {
  it("keeps RETURNED unless a status filter says otherwise, and respects the date range", () => {
    expect(matchesOrderFilter(row, { day: null, q: "", page: 0, pageSize: 30 })).toBe(true);
    expect(matchesOrderFilter(row, { day: null, from: "2026-10-01", to: "2026-10-27", q: "", page: 0, pageSize: 30 })).toBe(false);
    expect(matchesOrderFilter(row, { day: null, from: "2026-10-28", to: "2026-10-29", statuses: ["SHIPPED"], q: "", page: 0, pageSize: 30 })).toBe(false);
    expect(matchesOrderFilter(row, { day: null, from: "2026-10-28", to: "2026-10-29", statuses: ["RETURNED"], q: "sabun", page: 0, pageSize: 30 })).toBe(true);
  });

  it("matches a SKU exactly, so a shorter code does not include the longer one", () => {
    const pack = { ...row, sku: "40100090" };
    const variant = { ...row, sku: "40100090-01" };
    expect(matchesOrderFilter(pack, { day: null, q: "", skus: ["40100090"], page: 0, pageSize: 30 })).toBe(true);
    expect(matchesOrderFilter(variant, { day: null, q: "", skus: ["40100090"], page: 0, pageSize: 30 })).toBe(false);
    expect(matchesOrderFilter(variant, { day: null, q: "40100090", page: 0, pageSize: 30 })).toBe(true);
  });
});
