import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { BundleRecord } from "@/lib/jubelio/adapter";
import { canClaim, LEASE_MS, type ScheduleJob } from "@/lib/jubelio/schedule";

export type PullJob = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  trigger: string;
  triggeredBy: string;
  days: string[];
  day: string | null;
  page: number;
  listDone: boolean;
  pendingIds: number[];
  stats: { orders: number; lines: number; newVersions: number; reviews: number; failed: number };
  error: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

const FILE = path.join(process.cwd(), "data", "jubelio-jobs.json");

function client(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

function fail(error: { message?: string; code?: string } | null, action: string): never {
  const text = error?.message ?? "";
  const missing = error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|schema cache/i.test(text);
  if (/claim_jubelio_job|lease_token|lease_until|jubelio_jobs_status_check/i.test(text)) {
    throw new AppError("Jalankan supabase/migrations/0004_jubelio_job_lease.sql di SQL Editor.");
  }
  if (missing) throw new AppError("Migrasi 0003_phase1.sql belum dijalankan di Supabase.");
  throw new AppError(text || `Gagal ${action}.`);
}

function blank(trigger: string, actor: string, days: string[], status: PullJob["status"]): PullJob {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), status, trigger, triggeredBy: actor, days, day: null, page: 1, listDone: false, pendingIds: [],
    stats: { orders: 0, lines: 0, newVersions: 0, reviews: 0, failed: 0 }, error: null, leaseToken: null, leaseUntil: null, createdAt: now, updatedAt: now,
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

function statusOf(value: unknown): PullJob["status"] {
  if (value === "done" || value === "failed" || value === "queued" || value === "running") return value;
  return "running";
}

function fromRow(row: Record<string, unknown>): PullJob {
  const stats = (row.stats && typeof row.stats === "object" ? row.stats : {}) as PullJob["stats"];
  return {
    id: String(row.id),
    status: statusOf(row.status),
    trigger: String(row.trigger),
    triggeredBy: String(row.triggered_by),
    days: Array.isArray(row.days) ? row.days.map(String) : [],
    day: row.day ? String(row.day) : null,
    page: Number(row.page ?? 1),
    listDone: Boolean(row.list_done),
    pendingIds: Array.isArray(row.pending_ids) ? row.pending_ids.map(Number) : [],
    stats: { orders: stats.orders ?? 0, lines: stats.lines ?? 0, newVersions: stats.newVersions ?? 0, reviews: stats.reviews ?? 0, failed: stats.failed ?? 0 },
    error: row.error ? String(row.error) : null,
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    leaseUntil: row.lease_until ? String(row.lease_until) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRow(job: PullJob) {
  return {
    id: job.id, status: job.status, trigger: job.trigger, triggered_by: job.triggeredBy, days: job.days, day: job.day, page: job.page,
    list_done: job.listDone, pending_ids: job.pendingIds, stats: job.stats, error: job.error,
    lease_token: job.leaseToken, lease_until: job.leaseUntil, created_at: job.createdAt, updated_at: job.updatedAt,
  };
}

export function scheduleView(job: PullJob): ScheduleJob {
  return { id: job.id, status: job.status, trigger: job.trigger, days: job.days, createdAt: job.createdAt };
}

export async function createJob(trigger: string, actor: string, days: string[], status: "running" | "queued" = "running"): Promise<PullJob> {
  const job = blank(trigger, actor, days, status);
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

export async function openJobs(): Promise<PullJob[]> {
  if (!supabaseConfigured()) {
    return readJobs().jobs
      .filter((job) => job.status === "running" || job.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const { data, error } = await client().from("jubelio_jobs").select("*").in("status", ["running", "queued"]).order("created_at", { ascending: true });
  if (error) fail(error, "membaca job Jubelio");
  return ((data ?? []) as Record<string, unknown>[]).map(fromRow);
}

export async function activeRunning(): Promise<PullJob | null> {
  const jobs = await openJobs();
  return jobs.find((job) => job.status === "running") ?? null;
}

export async function latestJob(): Promise<PullJob | null> {
  const running = await activeRunning();
  if (running) return running;
  if (!supabaseConfigured()) return readJobs().jobs[0] ?? null;
  const { data, error } = await client().from("jubelio_jobs").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) fail(error, "membaca job Jubelio");
  return data ? fromRow(data as Record<string, unknown>) : null;
}

/** Compare-and-set. A second caller gets null while the lease is still held. */
export async function claimJob(id: string, token: string, now = Date.now()): Promise<PullJob | null> {
  const until = new Date(now + LEASE_MS).toISOString();
  if (!supabaseConfigured()) {
    const data = readJobs();
    const job = data.jobs.find((item) => item.id === id);
    if (!job || canClaim(job, token, now) !== "claim") return null;
    job.leaseToken = token;
    job.leaseUntil = until;
    job.updatedAt = new Date(now).toISOString();
    writeJobs(data);
    return job;
  }
  const { data, error } = await client().rpc("claim_jubelio_job", {
    p_id: id,
    p_token: token,
    p_lease_seconds: Math.round(LEASE_MS / 1000),
  });
  if (error) fail(error, "mengunci job Jubelio");
  const row = Array.isArray(data) ? data[0] : data;
  return row ? fromRow(row as Record<string, unknown>) : null;
}

export async function releaseJob(id: string, token: string) {
  if (!supabaseConfigured()) {
    const data = readJobs();
    const job = data.jobs.find((item) => item.id === id && item.leaseToken === token);
    if (!job) return;
    job.leaseToken = null;
    job.leaseUntil = null;
    job.updatedAt = new Date().toISOString();
    writeJobs(data);
    return;
  }
  const { error } = await client().from("jubelio_jobs").update({
    lease_token: null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("lease_token", token);
  if (error) fail(error, "melepas kunci job Jubelio");
}

export async function failJob(id: string, message: string) {
  const job = await getJob(id);
  if (!job || job.status !== "running") return;
  job.status = "failed";
  job.error = message;
  job.leaseToken = null;
  job.leaseUntil = null;
  await saveJob(job);
}

export async function markRunning(id: string): Promise<PullJob | null> {
  if (!supabaseConfigured()) {
    const data = readJobs();
    const running = data.jobs.find((job) => job.status === "running");
    if (running) return running;
    const job = data.jobs.find((item) => item.id === id && item.status === "queued");
    if (!job) return null;
    job.status = "running";
    job.leaseToken = null;
    job.leaseUntil = null;
    job.updatedAt = new Date().toISOString();
    writeJobs(data);
    return job;
  }
  const running = await activeRunning();
  if (running) return running;
  const { data, error } = await client().from("jubelio_jobs").update({
    status: "running",
    lease_token: null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "queued").select("*");
  if (error) {
    if (error.code === "23505") return activeRunning();
    fail(error, "membuka job Jubelio");
  }
  const row = Array.isArray(data) ? data[0] : null;
  return row ? fromRow(row as Record<string, unknown>) : activeRunning();
}

export async function promoteNext(): Promise<PullJob | null> {
  const jobs = await openJobs();
  if (jobs.some((job) => job.status === "running")) return null;
  const queued = jobs.find((job) => job.status === "queued");
  if (!queued) return null;
  return markRunning(queued.id);
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
