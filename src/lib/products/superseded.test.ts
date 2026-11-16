import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginHppSync } from "@/lib/products/hpp-sync";
import { deactivateSupersededProducts, listNameTargets, namedProductPayload, saveNamedProduct, type ProductRow } from "@/lib/products/service";
import { bundleKeyMentionsSku, bundleProtectedSkus, isSupersededAutoSku, type SupersededSkuInput } from "@/lib/products/superseded";
import type { CostPoint } from "@/lib/products/cost";

const productsFile = path.join(process.cwd(), "data", "products.json");
const storeFile = path.join(process.cwd(), "data", "store-v2.json");
const kept = new Map<string, string | null>();

function remember(file: string) {
  if (!kept.has(file)) kept.set(file, existsSync(file) ? readFileSync(file, "utf8") : null);
}

function restoreFiles() {
  for (const [file, previous] of kept) {
    if (previous == null) {
      if (existsSync(file)) unlinkSync(file);
    } else writeFileSync(file, previous);
  }
  kept.clear();
}

function writeJson(file: string, value: unknown) {
  remember(file);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function product(sku: string, patch: Partial<ProductRow> = {}): ProductRow {
  return {
    sku,
    name: patch.name ?? sku,
    categoryId: null,
    categoryName: null,
    brandId: patch.brandId ?? null,
    brandName: patch.brandName ?? null,
    active: patch.active ?? true,
    accurateFound: patch.accurateFound ?? "false",
    hpp: null,
    hppSource: null,
    hppDate: null,
    hppCarried: false,
    firstSoldAt: null,
    createdBy: patch.createdBy ?? null,
    updatedBy: patch.updatedBy ?? null,
    jubelioItemId: null,
    nameSource: patch.nameSource ?? null,
  };
}

const historical: SupersededSkuInput = {
  createdBy: null,
  active: true,
  accurateFound: "false",
  hasCost: false,
  onHistoricalOrder: true,
  onCurrentOrder: false,
  inBundle: false,
};

describe("superseded auto SKU predicate", () => {
  it("removes 0001897 when it is historical-only and keeps the other fixtures", () => {
    const cases: { sku: string; note: string; input: SupersededSkuInput; deactivate: boolean }[] = [
      { sku: "0001897", note: "historical only, no cost, accurate false", input: historical, deactivate: true },
      { sku: "0001897", note: "same leftover after a brand-only edit; updated_by is not a shield", input: historical, deactivate: true },
      { sku: "0001897", note: "accurate unknown is still a leftover", input: { ...historical, accurateFound: "unknown" }, deactivate: true },
      { sku: "0001897", note: "accurate null is still a leftover", input: { ...historical, accurateFound: null }, deactivate: true },
      {
        sku: "50001897",
        note: "current version, cost, accurate true",
        input: { ...historical, accurateFound: "true", hasCost: true, onCurrentOrder: true },
        deactivate: false,
      },
      {
        sku: "ACC-UNSOLD",
        note: "Accurate item with cost that was never ordered",
        input: { ...historical, accurateFound: "true", hasCost: true, onHistoricalOrder: false, onCurrentOrder: false },
        deactivate: false,
      },
      {
        sku: "DEL-ONLY",
        note: "SKU only on a current order with data_status deleted",
        input: { ...historical, onHistoricalOrder: false, onCurrentOrder: true },
        deactivate: false,
      },
      { sku: "COMP-1", note: "bundle component", input: { ...historical, inBundle: true }, deactivate: false },
      { sku: "NEVER-PLAIN", note: "never ordered", input: { ...historical, onHistoricalOrder: false }, deactivate: false },
      { sku: "OWNED", note: "created_by is set", input: { ...historical, createdBy: "sari@toko.test" }, deactivate: false },
      { sku: "0001897", note: "already inactive", input: { ...historical, active: false }, deactivate: false },
      { sku: "0001897", note: "has a product_costs row", input: { ...historical, hasCost: true }, deactivate: false },
    ];
    for (const row of cases) expect(isSupersededAutoSku(row.input), `${row.sku}: ${row.note}`).toBe(row.deactivate);
  });

  it("treats an exact bundle key or a bundle-component key as protection, not a neighboring SKU", () => {
    expect(bundleKeyMentionsSku("0001897", "0001897")).toBe(true);
    expect(bundleKeyMentionsSku("PAKET-0001897", "0001897")).toBe(true);
    expect(bundleKeyMentionsSku("0001897-KOMPONEN", "0001897")).toBe(true);
    expect(bundleKeyMentionsSku("50001897", "0001897")).toBe(false);
    expect(bundleKeyMentionsSku("0001897", "50001897")).toBe(false);
    expect([...bundleProtectedSkus(
      ["0001897", "COMP-1", "PAKET", "WKEY"],
      [{ bundleSku: "PAKET", componentSku: "COMP-1" }],
      ["PARENT-WKEY"],
    )].sort()).toEqual(["COMP-1", "PAKET", "WKEY"]);
  });

  it("sets active only when the named product is inserted", () => {
    const insert = namedProductPayload({ sku: "0001897", name: "Sementara", itemId: 1, source: "line", at: "2026-11-16T00:00:00.000Z" }, false);
    const update = namedProductPayload({ sku: "0001897", name: "Sementara", itemId: 1, source: "line", at: "2026-11-16T00:00:00.000Z" }, true);
    expect(insert.active).toBe(true);
    expect(update).not.toHaveProperty("active");
  });
});

describe("deactivateSupersededProducts local store", () => {
  afterEach(() => {
    restoreFiles();
  });

  it("soft-deletes 0001897 after a brand edit and leaves the other fixtures active", async () => {
    const cost = (sku: string): CostPoint => ({ sku, periodMonth: "2026-10-01", unitCost: 1000, source: "accurate", fetchedAt: "2026-10-01T00:00:00.000Z" });
    const store = {
      version: 2,
      versions: [
        { id: "v1", noPesanan: "587017731545663293", isCurrent: false, dataStatus: "active", lines: [{ sku: "0001897" }] },
        { id: "v2", noPesanan: "587017731545663293", isCurrent: true, dataStatus: "active", lines: [{ sku: "50001897" }] },
        { id: "v-del", noPesanan: "DEL-ORDER", isCurrent: true, dataStatus: "deleted", lines: [{ sku: "DEL-ONLY" }] },
        {
          id: "v-old",
          noPesanan: "OLD-1",
          isCurrent: false,
          lines: [{ sku: "COMP-1" }, { sku: "PAKET" }, { sku: "WKEY" }, { sku: "EXACTKEY" }, { sku: "OWNED" }],
        },
      ],
      weights: [{ bundleKey: "PARENT-WKEY" }, { bundleKey: "EXACTKEY" }],
      bundleComponents: [{ bundleSku: "PAKET", sku: "COMP-1" }],
    };
    writeJson(storeFile, store);
    const beforeStore = readFileSync(storeFile, "utf8");
    writeJson(productsFile, {
      categories: [],
      brands: [],
      products: [
        product("0001897", { accurateFound: "false", updatedBy: "sari@toko.test", brandId: "brand-1", brandName: "Merek" }),
        product("50001897", { accurateFound: "true" }),
        product("ACC-UNSOLD", { accurateFound: "true" }),
        product("NEVER-PLAIN", { accurateFound: "false" }),
        product("DEL-ONLY", { accurateFound: "false" }),
        product("COMP-1", { accurateFound: "false" }),
        product("PAKET", { accurateFound: "false" }),
        product("WKEY", { accurateFound: "false" }),
        product("EXACTKEY", { accurateFound: "false" }),
        product("OWNED", { accurateFound: "false", createdBy: "sari@toko.test" }),
      ],
      costs: [cost("50001897"), cost("ACC-UNSOLD")],
      runs: [],
    });

    const removed = await deactivateSupersededProducts();
    expect(removed).toEqual(["0001897"]);
    const db = JSON.parse(readFileSync(productsFile, "utf8")) as { products: ProductRow[]; costs: CostPoint[] };
    const bySku = new Map(db.products.map((row) => [row.sku, row]));
    expect(bySku.get("0001897")).toMatchObject({ active: false, updatedBy: "auto:superseded-sku", brandId: "brand-1", createdBy: null });
    expect(bySku.get("0001897")?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const sku of ["50001897", "ACC-UNSOLD", "NEVER-PLAIN", "DEL-ONLY", "COMP-1", "PAKET", "WKEY", "EXACTKEY", "OWNED"]) {
      expect(bySku.get(sku)?.active).toBe(true);
    }
    expect(db.costs.map((row) => row.sku).sort()).toEqual(["50001897", "ACC-UNSOLD"]);
    expect(readFileSync(storeFile, "utf8")).toBe(beforeStore);
    expect(await deactivateSupersededProducts()).toEqual([]);

    await saveNamedProduct({ sku: "0001897", name: "Nama Jubelio", itemId: 7, source: "line" });
    const again = JSON.parse(readFileSync(productsFile, "utf8")) as { products: ProductRow[] };
    expect(again.products.find((row) => row.sku === "0001897")?.active).toBe(false);
    await saveNamedProduct({ sku: "NEW-1", name: "Produk baru", itemId: null, source: "line" });
    const inserted = JSON.parse(readFileSync(productsFile, "utf8")) as { products: ProductRow[] };
    expect(inserted.products.find((row) => row.sku === "NEW-1")?.active).toBe(true);
  });

  it("skips inactive products in the HPP queue and the name refresh", async () => {
    writeJson(productsFile, {
      categories: [],
      brands: [],
      products: [
        product("ACTIVE-HPP", { accurateFound: "unknown", nameSource: null, updatedBy: null }),
        product("INACTIVE-HPP", { active: false, accurateFound: "unknown", nameSource: null, updatedBy: null }),
      ],
      costs: [],
      runs: [],
    });
    const names = await listNameTargets();
    expect(names.map((row) => row.sku)).toEqual(["ACTIVE-HPP"]);

    const previousToken = process.env.ACCURATE_API_TOKEN;
    const previousKey = process.env.ACCURATE_SIGNATURE_KEY;
    process.env.ACCURATE_API_TOKEN = "test-token";
    process.env.ACCURATE_SIGNATURE_KEY = "test-key";
    try {
      const run = await beginHppSync("manual", null);
      const queued = new Set(run.pendingSkus.map((item) => item.split("|")[1]));
      expect(queued.has("ACTIVE-HPP")).toBe(true);
      expect(queued.has("INACTIVE-HPP")).toBe(false);
    } finally {
      if (previousToken == null) delete process.env.ACCURATE_API_TOKEN;
      else process.env.ACCURATE_API_TOKEN = previousToken;
      if (previousKey == null) delete process.env.ACCURATE_SIGNATURE_KEY;
      else process.env.ACCURATE_SIGNATURE_KEY = previousKey;
    }
  });
});
