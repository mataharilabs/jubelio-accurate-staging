import { describe, expect, it } from "vitest";
import { planDelete, planSave, type SpendFile } from "@/lib/marketing/apply";
import type { MarketingRecord } from "@/lib/marketing/types";

function row(id: string, spend: number): MarketingRecord {
  return {
    id,
    uploadId: "up-1",
    lineNo: 1,
    periodStart: "2026-11-09",
    periodEnd: "2026-11-15",
    platform: "Shopee Ads",
    storeRaw: null,
    storeName: "Jansen Official Store",
    campaign: id,
    spend,
    impressions: 10,
    clicks: 2,
    orders: 1,
    adsRevenue: 50,
    source: "file",
    sourceFile: "a.csv",
    createdBy: "A",
    createdAt: "2026-11-19T01:00:00.000Z",
    deletedAt: null,
    deletedBy: null,
  };
}

describe("marketing Timpa plan", () => {
  it("writes the new rows, the soft-delete, and the audit together or not at all", () => {
    const original = row("old", 1000);
    const db: SpendFile = { rows: [original], audit: [] };
    const blocked = planSave(db, [row("new", 2500)], false, "2026-11-19T02:00:00.000Z");
    expect(blocked.ok).toBe(false);
    expect(original.deletedAt).toBeNull();
    expect(db.audit).toHaveLength(0);

    const saved = planSave(db, [{ ...row("new", 2500), createdBy: "Matahari Labs", uploadId: "up-2" }], true, "2026-11-19T02:00:00.000Z");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(original.deletedAt).toBeNull();
    expect(saved.replaced).toBe(1);
    expect(saved.db.rows.filter((item) => !item.deletedAt).map((item) => item.spend)).toEqual([2500]);
    expect(saved.db.rows.filter((item) => item.deletedAt).map((item) => item.id)).toEqual(["old"]);
    expect(saved.db.audit.map((item) => item.action).sort()).toEqual(["create", "overwrite"]);

    const retry = planSave(saved.db, [row("again", 2500)], false, "2026-11-19T03:00:00.000Z");
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.duplicates[0]?.ids).toEqual(["new"]);
    const replacedAgain = planSave(saved.db, [row("again", 2600)], true, "2026-11-19T03:00:00.000Z");
    expect(replacedAgain.ok).toBe(true);
    if (!replacedAgain.ok) return;
    expect(replacedAgain.db.rows.filter((item) => !item.deletedAt)).toHaveLength(1);
    expect(replacedAgain.db.rows.filter((item) => !item.deletedAt)[0]?.id).toBe("again");
  });

  it("soft-deletes and audits in one result", () => {
    const db: SpendFile = { rows: [row("old", 1000)], audit: [] };
    const next = planDelete(db, ["old"], "Matahari Labs", "2026-11-19T04:00:00.000Z");
    expect(db.rows[0]?.deletedAt).toBeNull();
    expect(next.rows[0]?.deletedAt).toBe("2026-11-19T04:00:00.000Z");
    expect(next.audit.map((item) => item.action)).toEqual(["delete"]);
  });
});
