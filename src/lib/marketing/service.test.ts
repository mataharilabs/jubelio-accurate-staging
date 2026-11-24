import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, addManual, listMarketing, softDeleteMarketing } from "@/lib/marketing/service";
import { supabaseConfigured } from "@/lib/env";

const dir = mkdtempSync(path.join(tmpdir(), "marketing-"));
const envKeys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "MARKETING_DATA_FILE"] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

describe("marketing save", () => {
  beforeEach(() => {
    process.env.MARKETING_DATA_FILE = path.join(dir, "marketing.json");
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    rmSync(process.env.MARKETING_DATA_FILE ?? "", { force: true });
    for (const key of envKeys) {
      if (savedEnv[key] == null) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("soft-deletes the previous period on Timpa and keeps an audit", async () => {
    expect(supabaseConfigured()).toBe(false);
    const input = {
      periodStart: "2026-11-09",
      periodEnd: "2026-11-15",
      platform: "Lazada Ads",
      storeName: "Bee & Flower",
      campaign: "Awal",
      spend: 1000,
      impressions: 10,
      clicks: 2,
      orders: 1,
      adsRevenue: 5000,
      stores: ["Bee & Flower"],
      overwrite: false,
      actor: "Matahari Labs",
    };
    await addManual(input);
    await expect(addManual({ ...input, campaign: "Baru", spend: 2500, overwrite: false })).rejects.toBeInstanceOf(ConflictError);
    const replaced = await addManual({ ...input, campaign: "Baru", spend: 2500, overwrite: true });
    expect(replaced).toEqual({ inserted: 1, replaced: 1 });
    const active = await listMarketing({ month: "2026-11", status: "active" });
    const deleted = await listMarketing({ month: "2026-11", status: "deleted" });
    expect(active.map((row) => row.spend)).toEqual([2500]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.deletedBy).toBe("Matahari Labs");
    const saved = JSON.parse(readFileSync(process.env.MARKETING_DATA_FILE ?? "", "utf8")) as { audit: { action: string }[]; rows: { deletedAt: string | null; spend: number }[] };
    expect(saved.rows.filter((row) => !row.deletedAt).map((row) => row.spend)).toEqual([2500]);
    expect(saved.audit.map((row) => row.action).sort()).toEqual(["create", "create", "overwrite"]);
    await expect(addManual({ ...input, periodStart: "", periodEnd: "", overwrite: false })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(addManual({ ...input, periodStart: "2026-02-31", periodEnd: "2026-02-31", overwrite: true })).rejects.toThrow(/tidak valid/);
    await expect(addManual({ ...input, periodEnd: "2026-12-02", overwrite: true })).rejects.toThrow(/bulan yang sama/);
    const removed = await softDeleteMarketing(active.map((row) => row.id), "Matahari Labs");
    expect(removed).toBe(1);
    expect(await listMarketing({ month: "2026-11", status: "active" })).toHaveLength(0);
  });
});
