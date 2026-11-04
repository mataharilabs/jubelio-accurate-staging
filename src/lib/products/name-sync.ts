import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { recordAudit } from "@/lib/access/store";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { JubelioClient } from "@/lib/jubelio/client";
import { itemIdentityFromDetail, matchItemByCode } from "@/lib/jubelio/item-name";
import { applyItemName, listNameTargets, type ItemLookup } from "@/lib/products/service";

const FILE = path.join(process.cwd(), "data", "product-name-runs.json");
const LEASE_MS = 45_000;
const SAMPLE = 8;

export type NameSample = { sku: string; before: string; after: string; source: "item" | "line" };

export type NameRun = {
  id: string;
  status: "running" | "done" | "failed";
  trigger: "manual" | "cron";
  startedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  skuCount: number;
  changedCount: number;
  fallbackCount: number;
  skippedCount: number;
  errorCount: number;
  error: string | null;
  pendingSkus: string[];
  sample: NameSample[];
  leaseToken: string | null;
  leaseUntil: string | null;
};

function sb(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

function readRuns(): NameRun[] {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as { runs?: NameRun[] };
    return parsed.runs ?? [];
  } catch {
    return [];
  }
}

function writeRuns(runs: NameRun[]) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ runs: runs.slice(0, 20) }));
}

function mapRun(row: Record<string, unknown>): NameRun {
  const status = row.status === "done" || row.status === "failed" ? row.status : "running";
  return {
    id: String(row.id),
    status,
    trigger: row.trigger === "cron" ? "cron" : "manual",
    startedBy: row.started_by ? String(row.started_by) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    skuCount: Number(row.sku_count ?? 0),
    changedCount: Number(row.changed_count ?? 0),
    fallbackCount: Number(row.fallback_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
    error: row.error ? String(row.error) : null,
    pendingSkus: Array.isArray(row.pending_skus) ? row.pending_skus.map(String) : [],
    sample: Array.isArray(row.sample) ? row.sample as NameSample[] : [],
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    leaseUntil: row.lease_until ? String(row.lease_until) : null,
  };
}

export async function latestNameRun(): Promise<NameRun | null> {
  if (!supabaseConfigured()) return readRuns()[0] ?? null;
  const { data, error } = await sb().from("product_name_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    if (/product_name_runs|schema cache|does not exist/i.test(error.message ?? "")) throw new AppError("Jalankan supabase/migrations/0007_product_names.sql di SQL Editor.");
    throw new AppError(error.message || "Gagal membaca nama produk.");
  }
  return data ? mapRun(data as Record<string, unknown>) : null;
}

async function saveRun(run: NameRun): Promise<void> {
  if (!supabaseConfigured()) {
    writeRuns([run, ...readRuns().filter((row) => row.id !== run.id)]);
    return;
  }
  const { error } = await sb().from("product_name_runs").upsert({
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    started_by: run.startedBy,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    sku_count: run.skuCount,
    changed_count: run.changedCount,
    fallback_count: run.fallbackCount,
    skipped_count: run.skippedCount,
    error_count: run.errorCount,
    error: run.error,
    pending_skus: run.pendingSkus,
    sample: run.sample,
    lease_token: run.leaseToken,
    lease_until: run.leaseUntil,
  });
  if (error) throw new AppError(error.message || "Gagal menyimpan nama produk.");
}

export function itemLookup(client: JubelioClient, deadline?: number): ItemLookup {
  return {
    async byId(itemId) {
      try {
        return itemIdentityFromDetail(await client.get(`/inventory/items/${itemId}`, undefined, deadline));
      } catch {
        return null;
      }
    },
    async byCode(sku) {
      try {
        const query = sku.replace(/[^A-Za-z0-9 ._-]/g, "").trim();
        if (!query) return null;
        const body = await client.get("/inventory/items/", { q: query, page: 1, page_size: 20 }, deadline);
        return matchItemByCode(body, sku);
      } catch {
        return null;
      }
    },
  };
}

export async function planNameContinue(now = Date.now()): Promise<"idle" | "busy" | "resume"> {
  const current = await latestNameRun().catch(() => null);
  if (current?.status === "running") {
    if (current.leaseUntil && Date.parse(current.leaseUntil) > now && current.pendingSkus.length) return "busy";
    return current.pendingSkus.length ? "resume" : "idle";
  }
  const targets = await listNameTargets().catch(() => []);
  return targets.length ? "resume" : "idle";
}

export async function beginNameSync(trigger: "manual" | "cron", by: string | null): Promise<NameRun> {
  const current = await latestNameRun();
  if (current?.status === "running" && current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) return current;
  const pending = current?.status === "running" ? current.pendingSkus : (await listNameTargets()).map((row) => row.sku);
  const run: NameRun = {
    id: current?.status === "running" ? current.id : crypto.randomUUID(),
    status: pending.length ? "running" : "done",
    trigger,
    startedBy: by,
    startedAt: current?.status === "running" ? current.startedAt : new Date().toISOString(),
    finishedAt: pending.length ? null : new Date().toISOString(),
    skuCount: current?.status === "running" ? current.skuCount : pending.length,
    changedCount: current?.status === "running" ? current.changedCount : 0,
    fallbackCount: current?.status === "running" ? current.fallbackCount : 0,
    skippedCount: current?.status === "running" ? current.skippedCount : 0,
    errorCount: current?.status === "running" ? current.errorCount : 0,
    error: pending.length ? null : "Tidak ada nama yang perlu diperbarui.",
    pendingSkus: pending,
    sample: current?.status === "running" ? current.sample : [],
    leaseToken: null,
    leaseUntil: null,
  };
  await saveRun(run);
  return run;
}

function remember(run: NameRun, sample: NameSample) {
  if (run.sample.length >= SAMPLE) return;
  run.sample.push(sample);
}

export async function advanceNameSync(budgetMs: number, trigger: "manual" | "cron" = "cron", by: string | null = null): Promise<NameRun> {
  const token = crypto.randomUUID();
  let run = await latestNameRun();
  if (!run || run.status !== "running") run = await beginNameSync(trigger, by);
  if (run.status !== "running") return run;
  if (run.leaseUntil && Date.parse(run.leaseUntil) > Date.now() && run.leaseToken && run.leaseToken !== token) return run;
  run.leaseToken = token;
  run.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  await saveRun(run);
  const deadline = Date.now() + budgetMs;
  const client = new JubelioClient();
  const lookup = itemLookup(client, deadline);
  try {
    if (!client.configured()) {
      run.status = "failed";
      run.error = "JUBELIO_EMAIL dan JUBELIO_PASSWORD belum diisi.";
      run.finishedAt = new Date().toISOString();
      return run;
    }
    while (run.pendingSkus.length && Date.now() + 8_000 < deadline) {
      const sku = run.pendingSkus[0];
      run.pendingSkus = run.pendingSkus.slice(1);
      const target = (await listNameTargets()).find((row) => row.sku === sku);
      if (!target) {
        run.skippedCount += 1;
        continue;
      }
      try {
        const found = await lookup.byCode(sku);
        const outcome = await applyItemName({
          sku,
          name: found?.name?.trim() || target.name,
          itemId: found?.id ?? null,
          source: found?.name?.trim() ? "item" : "line",
        });
        if (outcome === "changed") run.changedCount += 1;
        else if (outcome === "fallback") run.fallbackCount += 1;
        else run.skippedCount += 1;
        if (outcome !== "skipped") remember(run, { sku, before: target.name, after: found?.name?.trim() || target.name, source: found?.name?.trim() ? "item" : "line" });
      } catch (error) {
        run.errorCount += 1;
        run.error = error instanceof Error ? error.message : "Gagal membaca item Jubelio.";
        run.pendingSkus.push(sku);
        break;
      }
      run.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      await saveRun(run);
    }
    if (!run.pendingSkus.length) {
      run.status = "done";
      run.finishedAt = new Date().toISOString();
    }
  } finally {
    run.leaseToken = null;
    run.leaseUntil = null;
    await saveRun(run);
    if (run.status !== "running") {
      await recordAudit({
        actorEmail: run.startedBy ?? "jubelio",
        action: "product.names",
        entity: "product_name_run",
        entityId: run.id,
        before: null,
        after: { changed: run.changedCount, fallback: run.fallbackCount, skipped: run.skippedCount, errors: run.errorCount, sample: run.sample },
      }).catch(() => undefined);
    }
  }
  return run;
}
