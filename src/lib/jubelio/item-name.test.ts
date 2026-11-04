import { describe, expect, it } from "vitest";
import { chooseProductName, itemIdentityFromDetail, itemNameFromPayload, matchItemByCode, mayReplaceName, productSeedsFromOrders } from "@/lib/jubelio/item-name";

describe("Jubelio item name", () => {
  it("reads only the name field and ignores the rest of the payload", () => {
    expect(itemNameFromPayload({ data: [{ item_code: "SKU", item_name: "  Sabun  ", secret: "nope" }] })).toBe("Sabun");
    expect(itemNameFromPayload({ name: "Cadangan" })).toBe("Cadangan");
    expect(itemNameFromPayload({})).toBeNull();
  });

  it("keeps only id and name when matching a SKU", () => {
    const body = {
      data: [
        { item_id: 4, item_code: "LAIN", item_name: "Bukan ini", thumbnail: "https://secret.example/a.jpg" },
        { item_id: 9, item_code: "SKU-1", item_name: "Nama master", stock: 40, price: 1000 },
      ],
    };
    const found = matchItemByCode(body, "SKU-1");
    expect(found).toEqual({ id: 9, name: "Nama master" });
    expect(Object.keys(found ?? {})).toEqual(["id", "name"]);
    expect(matchItemByCode(body, "TIDAK-ADA")).toBeNull();
    const detail = itemIdentityFromDetail({ item_id: 9, item_name: "Nama master", bundles: [{ item_code: "X" }] });
    expect(detail).toEqual({ id: 9, name: "Nama master" });
  });

  it("resolves a plain line to its item id and a bundle to the component id", () => {
    const bundles = new Map([[7, { bundles: [{ item_id: 70, item_code: "40100083-01", item_name: "Bee & Flower Cendana" }] }]]);
    const seeds = productSeedsFromOrders([{
      items: [
        { item_id: 8, item_code: "SINGLE", description: "Nama di pesanan", is_bundle: false },
        { item_id: 7, item_code: "BDL", description: "Paket di pesanan", is_bundle: true },
      ],
    }], bundles);
    expect(seeds).toEqual([
      { sku: "SINGLE", lineName: "Nama di pesanan", itemId: 8 },
      { sku: "40100083-01", lineName: "Bee & Flower Cendana", itemId: 70 },
    ]);
  });

  it("uses the item master name and falls back only when the master has none", () => {
    expect(chooseProductName({ masterName: " Nama master ", lineName: "Nama pesanan", existingName: "Lama" })).toEqual({ name: "Nama master", source: "item" });
    expect(chooseProductName({ masterName: null, lineName: "Nama pesanan", existingName: "Lama" })).toEqual({ name: "Lama", source: "line" });
    expect(chooseProductName({ masterName: "", lineName: "Nama pesanan" })).toEqual({ name: "Nama pesanan", source: "line" });
    expect(mayReplaceName(null)).toBe(true);
    expect(mayReplaceName("jubelio")).toBe(true);
    expect(mayReplaceName("admin@example.com")).toBe(false);
  });
});
