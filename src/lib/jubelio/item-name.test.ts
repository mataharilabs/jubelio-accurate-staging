import { describe, expect, it } from "vitest";
import { chooseProductName, classifyLookup, classifyNameUpdate, itemIdentityFromDetail, itemNameFromPayload, matchItemByCode, mayReplaceName, productSeedsFromOrders } from "@/lib/jubelio/item-name";

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
    const grouped = {
      data: [{
        item_group_id: 1931,
        item_name: "Nama grup",
        thumbnail: "https://secret.example/group.jpg",
        variants: [
          { item_id: 1, item_code: "LAIN", item_name: "Lain", thumbnail: "https://secret.example/a.jpg" },
          { item_id: 2976, item_code: "A2143", sell_price: 3600000, barcode: 128124871847 },
        ],
      }],
    };
    const variant = matchItemByCode(grouped, "A2143");
    expect(variant).toEqual({ id: 2976, name: "Nama grup" });
    expect(Object.keys(variant ?? {})).toEqual(["id", "name"]);
    expect(JSON.stringify(variant)).not.toContain("secret");
    expect(matchItemByCode({
      data: [{
        item_id: 7,
        item_code: "BDL",
        item_name: "Paket",
        bundles: [{ item_id: 70, item_code: "40100083-01", item_name: "Bee & Flower Cendana", qty: 4 }],
      }],
    }, "40100083-01")).toEqual({ id: 70, name: "Bee & Flower Cendana" });
    const detail = itemIdentityFromDetail({ item_id: 9, item_name: "Nama master", bundles: [{ item_code: "X" }] });
    expect(detail).toEqual({ id: 9, name: "Nama master" });
  });

  it("does not create products from items outside the allowed locations", () => {
    const bundles = new Map([[7, { bundles: [{ item_id: 70, item_code: "COMP", item_name: "Komponen" }] }]]);
    const orders = [{
      location_name: "Gudang lain",
      items: [
        { item_id: 7, item_code: "BDL", description: "Paket", is_bundle: true, loc_name: "Gudang lain" },
        { item_id: 8, item_code: "KEEP", description: "Yang lolos", is_bundle: false, loc_name: "Lintas Sby" },
        { item_id: 9, item_code: "DROP", description: "Lokasi lain", is_bundle: false, loc_name: "East Java & Co" },
        { item_id: 10, item_code: "ORDERLOC", description: "Ikut lokasi order", is_bundle: false, loc_name: "" },
      ],
    }];
    const seeds = productSeedsFromOrders(orders, bundles, { locations: ["Lintas Sby"] });
    expect(seeds.map((seed) => seed.sku)).toEqual(["KEEP"]);
    expect(seeds.some((seed) => seed.sku === "COMP" || seed.sku === "DROP" || seed.sku === "ORDERLOC")).toBe(false);
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

  it("counts a real change, a miss, and a failed lookup separately", () => {
    const current = { name: "Nama pesanan", itemId: null as number | null };
    expect(classifyNameUpdate(current, { name: "Nama master", itemId: 9, source: "item" })).toBe("changed");
    expect(classifyNameUpdate(current, { name: "Nama pesanan", itemId: 9, source: "item" })).toBe("changed");
    expect(classifyNameUpdate({ name: "Nama master", itemId: 9 }, { name: "Nama master", itemId: 9, source: "item" })).toBe("unchanged");
    expect(classifyNameUpdate(current, { name: "Nama pesanan", itemId: null, source: "line" })).toBe("fallback");
    expect(classifyLookup({ failed: true, identity: null })).toBe("error");
    expect(classifyLookup({ failed: false, identity: null })).toBe("missing");
    expect(classifyLookup({ failed: false, identity: { id: 9, name: null } })).toBe("item");
    expect(classifyLookup({ failed: false, identity: { id: 9, name: "Nama master" } })).toBe("item");
  });
});
