import { describe, expect, it } from "vitest";
import type { JubelioClient } from "@/lib/jubelio/client";
import { cronNameBackedOff, cronNameSkus, isStepTimeout, itemLookup, itemSearchQuery, NAME_ERROR_RUN_LIMIT, NAME_SYNC_GENERATION } from "@/lib/products/name-sync";

describe("Jubelio item search", () => {
  it("asks the item list for page, pageSize, and q", async () => {
    expect(itemSearchQuery("SKU-1")).toEqual({ q: "SKU-1", page: 1, pageSize: 20 });
    expect(itemSearchQuery("SKU-1")).not.toHaveProperty("page_size");
    const calls: Array<{ path: string; query?: Record<string, string | number> }> = [];
    const client = {
      async get(path: string, query?: Record<string, string | number>) {
        calls.push({ path, query });
        return { data: [{ item_name: "Grup", variants: [{ item_id: 9, item_code: "SKU-1", item_name: "Nama master" }] }] };
      },
    };
    const found = await itemLookup(client as unknown as JubelioClient).byCode("SKU-1");
    expect(calls).toEqual([{ path: "/inventory/items/", query: { q: "SKU-1", page: 1, pageSize: 20 } }]);
    expect(found).toEqual({ id: 9, name: "Nama master" });
  });

  it("does not start another cron run for line rows the last done run already tried", () => {
    const targets = [
      { sku: "BARU", nameSource: null },
      { sku: "LAMA", nameSource: "line" as const },
      { sku: "MASTER", nameSource: "item" as const },
    ];
    expect(cronNameSkus(targets, ["LAMA"])).toEqual(["BARU"]);
    expect(cronNameSkus(targets, [])).toEqual(["BARU", "LAMA"]);
  });

  it("backs off after consecutive error runs and ignores a step timeout", () => {
    const failed = { status: "failed", generation: NAME_SYNC_GENERATION, errorCount: 1, changedCount: 0, fallbackCount: 0 };
    expect(cronNameBackedOff([failed, failed])).toBe(false);
    expect(cronNameBackedOff(Array.from({ length: NAME_ERROR_RUN_LIMIT }, () => failed))).toBe(true);
    expect(cronNameBackedOff([failed, failed, failed, { ...failed, generation: 1 }])).toBe(true);
    expect(cronNameBackedOff([failed, { ...failed, generation: 1 }, failed, failed])).toBe(false);
    expect(isStepTimeout(new Error("Waktu langkah habis."))).toBe(true);
    expect(isStepTimeout(new Error("Jubelio menolak /inventory/items/ (400)."))).toBe(false);
  });
});
