import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { BundleRecord } from "@/lib/jubelio/adapter";

export type PullJob = {
  id: string;
  status: "running" | "done" | "failed";
  trigger: string;
  triggeredBy: string;
  days: string[];
  day: string | null;
  page: number;
  listDone: boolean;
  pendingIds: number[];
  stats: { orders: number; lines: number; newVersions: number; reviews: number; failed: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

const FILE = path.join(process.cwd(), "data", "jubelio-jobs.json");

function client(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

function fail(error: { message?: string; code?: string } | null, action: string): never {
  const missing = error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|schema cache/i.test(error?.message ?? "");
  if (missing) throw new AppError("Migrasi 0003_phase1.sql belum dijalankan di Supabase.");
  throw new AppError(error?.message || `Gagal ${action}.`);
}

function blank(trigger: string, actor: string, days: string[]): PullJob {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), status: "running", trigger, triggeredBy: actor, days, day: null, page: 1, listDone: false, pendingIds: [],
    stats: { orders: 0, lines: 0, newVersions: 0, reviews: 0, failed: 0 }, error: null, createdAt: now, updatedAt: now,
  };
}

function readJobs(): { jobs: PullJob[]; bundles: Record<string, BundleRecord> } {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as { jobs: PullJob[]; bundles: Record<string, BundleRecord> };
  } catch {
    return { jobs: [], bundles: {} };
  }
}

function writeJobs(data: { jobs: PullJob[]; bundles: Record<string, BundleRecord> }) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(data));
}

function fromRow(row: Record<string, unknown>): PullJob {
  const stats = (row.stats && typeof row.stats === "object" ? row.stats : {}) as PullJob["stats"];
  return {
    id: String(row.id),
    status: row.status === "done" || row.status === "failed" ? row.status : "running",
    trigger: String(row.trigger),
    triggeredBy: String(row.triggered_by),
    days: Array.isArray(row.days) ? row.days.map(String) : [],
    day: row.day ? String(row.day) : null,
    page: Number(row.page ?? 1),
    listDone: Boolean(row.list_done),
    pendingIds: Array.isArray(row.pending_ids) ? row.pending_ids.map(Number) : [],
    stats: { orders: stats.orders ?? 0, lines: stats.lines ?? 0, newVersions: stats.newVersions ?? 0, reviews: stats.reviews ?? 0, failed: stats.failed ?? 0 },
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRow(job: PullJob) {
  return {
    id: job.id, status: job.status, trigger: job.trigger, triggered_by: job.triggeredBy, days: job.days, day: job.day, page: job.page,
    list_done: job.listDone, pending_ids: job.pendingIds, stats: job.stats, error: job.error, created_at: job.createdAt, updated_at: job.updatedAt,
  };
}

export async function createJob(trigger: string, actor: string, days: string[]): Promise<PullJob> {
  const job = blank(trigger, actor, days);
  if (!supabaseConfigured()) {
    const data = readJobs();
    data.jobs.unshift(job);
    writeJobs(data);
    return job;
  }
  const { error } = await client().from("jubelio_jobs").insert(toRow(job));
  if (error) fail(error, "membuat job Jubelio");
  return job;
}

export async function saveJob(job: PullJob) {
  job.updatedAt = new Date().toISOString();
  if (!supabaseConfigured()) {
    const data = readJobs();
    data.jobs = data.jobs.map((item) => item.id === job.id ? job : item);
    writeJobs(data);
    return;
  }
  const { error } = await client().from("jubelio_jobs").update(toRow(job)).eq("id", job.id);
  if (error) fail(error, "menyimpan job Jubelio");
}

export async function getJob(id: string): Promise<PullJob | null> {
  if (!supabaseConfigured()) return readJobs().jobs.find((job) => job.id === id) ?? null;
  const { data, error } = await client().from("jubelio_jobs").select("*").eq("id", id).maybeSingle();
  if (error) fail(error, "membaca job Jubelio");
  return data ? fromRow(data as Record<string, unknown>) : null;
}

export async function latestJob(): Promise<PullJob | null> {
  if (!supabaseConfigured()) return readJobs().jobs[0] ?? null;
  const { data, error } = await client().from("jubelio_jobs").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) fail(error, "membaca job Jubelio");
  return data ? fromRow(data as Record<string, unknown>) : null;
}

export async function bundleMap(ids: number[]): Promise<Map<number, BundleRecord>> {
  const map = new Map<number, BundleRecord>();
  if (!ids.length) return map;
  if (!supabaseConfigured()) {
    const data = readJobs();
    for (const id of ids) {
      const record = data.bundles[String(id)];
      if (record) map.set(id, record);
    }
    return map;
  }
  const { data, error } = await client().from("jubelio_bundles").select("*").in("item_id", ids);
  if (error) fail(error, "membaca cache bundle");
  for (const row of data ?? []) {
    map.set(Number(row.item_id), { item_id: Number(row.item_id), bundles: Array.isArray(row.components) ? row.components : [] });
  }
  return map;
}

export async function saveBundles(records: BundleRecord[]) {
  if (!records.length) return;
  if (!supabaseConfigured()) {
    const data = readJobs();
    for (const record of records) data.bundles[String(record.item_id)] = record;
    writeJobs(data);
    return;
  }
  const { error } = await client().from("jubelio_bundles").upsert(records.map((record) => ({
    item_id: record.item_id,
    components: record.bundles,
    updated_at: new Date().toISOString(),
  })));
  if (error) fail(error, "menyimpan cache bundle");
}
