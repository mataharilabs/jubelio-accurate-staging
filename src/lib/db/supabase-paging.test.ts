import { describe, expect, it } from "vitest";
import { commitWithRollback, eachPage, pickLatestRows } from "@/lib/db/supabase-paging";

describe("supabase paging", () => {
  it("keeps reading after a full page so existing orders are not mistaken for new", async () => {
    const calls: number[] = [];
    const rows = await eachPage(async (from, to) => {
      calls.push(from);
      expect(to - from + 1).toBe(2);
      if (from === 0) return ["a", "b"];
      if (from === 2) return ["c"];
      throw new Error("should stop after a short page");
    }, 2);
    expect(rows).toEqual(["a", "b", "c"]);
    expect(calls).toEqual([0, 2]);
  });

  it("stops on an empty page", async () => {
    const rows = await eachPage(async () => [], 1000);
    expect(rows).toEqual([]);
  });

  it("stops instead of looping when a page is larger than requested", async () => {
    await expect(eachPage(async () => ["a", "b", "c"], 2)).rejects.toThrow("permintaan 2");
  });

  it("picks the highest version_no even when it is numeric text and an older row is seen later", () => {
    const latest = pickLatestRows([
      { no_pesanan: "A", version_no: "2" },
      { no_pesanan: "A", version_no: "10" },
      { no_pesanan: "B", version_no: 1 },
      { no_pesanan: "A", version_no: 9 },
    ]);
    expect(latest).toEqual([
      { no_pesanan: "A", version_no: "10" },
      { no_pesanan: "B", version_no: 1 },
    ]);
  });

  it("restores completed steps in reverse when a later write fails", async () => {
    const log: string[] = [];
    await expect(commitWithRollback([
      { run: async () => { log.push("retire"); }, undo: async () => { log.push("restore"); } },
      { run: async () => { throw new Error("duplicate key"); }, undo: async () => { log.push("unused"); } },
    ])).rejects.toThrow("duplicate key");
    expect(log).toEqual(["retire", "restore"]);
  });
});
