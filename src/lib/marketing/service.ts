import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { eachPage } from "@/lib/db/supabase-paging";
import { AppError } from "@/lib/errors";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { formatPeriod, monthEnd, sameCalendarMonth } from "@/lib/marketing/dates";
import { duplicateGroups, type Span } from "@/lib/marketing/overlap";
import { isPlatform, parseUpload } from "@/lib/marketing/parse";
import { matchStore } from "@/lib/marketing/stores";
import type { DuplicateGroup, MarketingFilter, MarketingRecord, ParseResult, SpendDraft, SpendSource } from "@/lib/marketing/types";

export class ConflictError extends AppError {
  duplicates: DuplicateGroup[];
  constructor(message: string, duplicates: DuplicateGroup[]) {
    super(message, 409);
    this.name = "ConflictError";
    this.duplicates = duplicates;
  }
}

type FileDb = { rows: MarketingRecord[]; audit: unknown[] };

type Resolved = SpendDraft & { storeName: string };

export type PreparedUpload = {
  source: SpendSource;
  filename: string;
  parsed: ParseResult;
  rows: Resolved[];
  unresolved: string[];
  storeMatch: string | null;
  storeAmbiguous: string[];
  duplicates: DuplicateGroup[];
};

function filePath(): string {
  return process.env.MARKETING_DATA_FILE || path.join(process.cwd(), "data", "marketing.json");
}

function readDb(): FileDb {
  let text: string;
  try {
    text = readFileSync(filePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], audit: [] };
    throw error;
  }
  const parsed = JSON.parse(text) as FileDb;
  return { rows: parsed.rows ?? [], audit: parsed.audit ?? [] };
}

let fileQueue: Promise<unknown> = Promise.resolve();

function withFileLock<T>(work: () => Promise<T>): Promise<T> {
  const run = fileQueue.then(work, work);
  fileQueue = run.then(() => undefined, () => undefined);
  return run;
}

function writeDb(db: FileDb) {
  mkdirSync(path.dirname(filePath()), { recursive: true });
  writeFileSync(filePath(), JSON.stringify(db));
}

function client(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

function missingSchema(error: { message?: string; code?: string } | null): boolean {
  const code = error?.code ?? "";
  if (code === "42501") return false;
  const text = error?.message ?? "";
  return code === "42P01" || code === "PGRST205" || code === "PGRST202" || /does not exist|schema cache|could not find the function/i.test(text);
}

function schemaOrFail(error: { message?: string; code?: string } | null, action: string): never {
  if (missingSchema(error)) throw new AppError("Jalankan supabase/migrations/0013_marketing_spend.sql di SQL Editor.");
  throw new AppError(error?.message || `Gagal ${action}.`);
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fromRemote(row: Record<string, unknown>): MarketingRecord {
  return {
    id: String(row.id),
    uploadId: String(row.upload_id ?? ""),
    lineNo: num(row.line_no),
    periodStart: String(row.period_start).slice(0, 10),
    periodEnd: String(row.period_end).slice(0, 10),
    platform: String(row.platform),
    storeName: String(row.store_name),
    storeRaw: null,
    campaign: String(row.campaign ?? ""),
    spend: num(row.spend),
    impressions: numOrNull(row.impressions),
    clicks: numOrNull(row.clicks),
    orders: numOrNull(row.orders),
    adsRevenue: numOrNull(row.ads_revenue),
    source: (row.source === "manual" || row.source === "template" ? row.source : "file"),
    sourceFile: String(row.source_file ?? ""),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at ?? ""),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    deletedBy: row.deleted_by ? String(row.deleted_by) : null,
  };
}

function toRemote(row: MarketingRecord) {
  return {
    id: row.id,
    upload_id: row.uploadId,
    line_no: row.lineNo,
    period_start: row.periodStart,
    period_end: row.periodEnd,
    platform: row.platform,
    store_name: row.storeName,
    campaign: row.campaign,
    spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    orders: row.orders,
    ads_revenue: row.adsRevenue,
    source: row.source,
    source_file: row.sourceFile,
    created_by: row.createdBy,
    created_at: row.createdAt,
    deleted_at: row.deletedAt,
    deleted_by: row.deletedBy,
  };
}

async function loadRows(status: MarketingFilter["status"]): Promise<MarketingRecord[]> {
  if (!supabaseConfigured()) {
    const rows = readDb().rows;
    if (status === "active") return rows.filter((row) => !row.deletedAt);
    if (status === "deleted") return rows.filter((row) => row.deletedAt);
    return rows;
  }
  const data = await eachPage(async (from, to) => {
    let query = client().from("marketing_spend").select("*").order("period_start", { ascending: true }).order("line_no", { ascending: true }).order("id", { ascending: true });
    if (status === "active") query = query.is("deleted_at", null);
    if (status === "deleted") query = query.not("deleted_at", "is", null);
    const { data: page, error } = await query.range(from, to);
    if (error) schemaOrFail(error, "membaca marketing spending");
    return (page ?? []) as Record<string, unknown>[];
  });
  return data.map(fromRemote);
}

const PLATFORM_RANK = ["Shopee Ads", "TikTok Ads", "Meta Ads", "CPAS", "Lazada Ads", "Blibli Ads", "Lainnya"];

function sortRows(rows: MarketingRecord[]): MarketingRecord[] {
  return [...rows].sort((a, b) => {
    const rank = PLATFORM_RANK.indexOf(a.platform) - PLATFORM_RANK.indexOf(b.platform);
    if (rank) return rank;
    if (a.periodStart !== b.periodStart) return a.periodStart < b.periodStart ? -1 : 1;
    if (a.lineNo !== b.lineNo) return a.lineNo - b.lineNo;
    return a.campaign.localeCompare(b.campaign, "id");
  });
}

export async function listMarketing(filter: MarketingFilter): Promise<MarketingRecord[]> {
  const rows = await loadRows(filter.status);
  const start = `${filter.month}-01`;
  const end = monthEnd(filter.month);
  return sortRows(rows.filter((row) => row.periodStart <= end && row.periodEnd >= start));
}

export async function listSpendStores(): Promise<string[]> {
  try {
    const rows = await loadRows("all");
    return [...new Set(rows.map((row) => row.storeName).filter(Boolean))];
  } catch (error) {
    if (error instanceof AppError && /0013_marketing_spend/.test(error.message)) return [];
    throw error;
  }
}

export async function listActiveSlices(): Promise<{ storeName: string; periodStart: string; periodEnd: string; spend: number }[]> {
  try {
    const rows = await loadRows("active");
    return rows.map((row) => ({ storeName: row.storeName, periodStart: row.periodStart, periodEnd: row.periodEnd, spend: row.spend }));
  } catch (error) {
    if (error instanceof AppError && /0013_marketing_spend/.test(error.message)) return [];
    throw error;
  }
}

function spansOf(rows: MarketingRecord[]): Span[] {
  return rows.map((row) => ({ id: row.id, platform: row.platform, storeName: row.storeName, periodStart: row.periodStart, periodEnd: row.periodEnd }));
}

export function duplicateText(groups: DuplicateGroup[]): string {
  if (!groups.length) return "";
  const lines = groups.map((group) => `Sudah ada ${group.count} baris ${group.platform} untuk toko ${group.storeName} dengan periode yang bertumpuk (${formatPeriod(group.periodStart, group.periodEnd)}).`);
  return `${lines.join(" ")} Pilih Timpa untuk mengganti data lama dengan file ini, atau Batal untuk membatalkan upload.`;
}

function canonicalStore(name: string, stores: string[]): string {
  const exact = stores.find((store) => store.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  return matchStore(name, stores).match ?? name;
}

export async function prepareUpload(input: { filename: string; buffer: Buffer; platform: string; storeName: string | null; stores: string[] }): Promise<PreparedUpload> {
  const parsed = parseUpload(input.filename, input.buffer, input.platform);
  const source: SpendSource = parsed.kind === "template" ? "template" : "file";
  if (parsed.crossesMonth) {
    return { source, filename: input.filename, parsed, rows: [], unresolved: [], storeMatch: null, storeAmbiguous: [], duplicates: [] };
  }
  let storeMatch: string | null = null;
  let storeAmbiguous: string[] = [];
  let unresolved: string[] = [];
  let rows: Resolved[] = [];
  if (parsed.kind === "template") {
    const missing = new Set<string>();
    rows = parsed.rows.flatMap((row) => {
      const matched = row.storeRaw ? matchStore(row.storeRaw, input.stores).match : null;
      if (!matched) {
        if (row.storeRaw) missing.add(row.storeRaw);
        return [];
      }
      return [{ ...row, storeName: matched }];
    });
    unresolved = [...missing];
  } else {
    const detected = parsed.storeRaw ? matchStore(parsed.storeRaw, input.stores) : { match: null, ambiguous: [] as string[] };
    storeMatch = detected.match;
    storeAmbiguous = detected.ambiguous;
    const chosenRaw = input.storeName ? canonicalStore(input.storeName, input.stores) : storeMatch;
    const known = !input.storeName || !input.stores.length || input.stores.some((store) => store.toLowerCase() === (chosenRaw ?? "").toLowerCase());
    const chosen = known ? chosenRaw : null;
    if (chosen) rows = parsed.rows.map((row) => ({ ...row, storeName: chosen }));
    else if (parsed.rows.length) unresolved = [input.storeName || parsed.storeRaw || "(toko belum dipilih)"];
  }
  const active = rows.length ? await loadRows("active") : [];
  const duplicates = rows.length ? duplicateGroups(spansOf(active), rows) : [];
  return { source, filename: input.filename, parsed, rows, unresolved, storeMatch, storeAmbiguous, duplicates };
}

async function insertRows(rows: MarketingRecord[]) {
  if (!rows.length) return;
  if (!supabaseConfigured()) {
    const db = readDb();
    db.rows.push(...rows);
    writeDb(db);
    return;
  }
  for (let index = 0; index < rows.length; index += 200) {
    const { error } = await client().from("marketing_spend").insert(rows.slice(index, index + 200).map(toRemote));
    if (error) schemaOrFail(error, "menyimpan marketing spending");
  }
}

async function markDeleted(ids: string[], actor: string) {
  if (!ids.length) return;
  const now = new Date().toISOString();
  if (!supabaseConfigured()) {
    const db = readDb();
    for (const row of db.rows) {
      if (ids.includes(row.id) && !row.deletedAt) {
        row.deletedAt = now;
        row.deletedBy = actor;
      }
    }
    writeDb(db);
    return;
  }
  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200);
    const { error } = await client().from("marketing_spend").update({ deleted_at: now, deleted_by: actor }).in("id", chunk);
    if (error) schemaOrFail(error, "menutup baris lama");
  }
}

async function writeSpendAudit(entries: { spendId: string | null; uploadId: string | null; action: "create" | "overwrite" | "delete"; actor: string; platform: string; storeName: string; periodStart: string; periodEnd: string; snapshot: unknown }[]) {
  if (!entries.length) return;
  const now = new Date().toISOString();
  if (!supabaseConfigured()) {
    const db = readDb();
    db.audit.unshift(...entries.map((entry) => ({ id: crypto.randomUUID(), at: now, ...entry })));
    db.audit = db.audit.slice(0, 5000);
    writeDb(db);
    return;
  }
  const payload = entries.map((entry) => ({
    id: crypto.randomUUID(),
    spend_id: entry.spendId,
    upload_id: entry.uploadId,
    action: entry.action,
    actor: entry.actor,
    at: now,
    platform: entry.platform,
    store_name: entry.storeName,
    period_start: entry.periodStart,
    period_end: entry.periodEnd,
    snapshot: entry.snapshot ?? {},
  }));
  for (let index = 0; index < payload.length; index += 200) {
    const { error } = await client().from("marketing_spend_audit").insert(payload.slice(index, index + 200));
    if (error) schemaOrFail(error, "mencatat audit marketing");
  }
}

function materialize(rows: Resolved[], source: SpendSource, filename: string, actor: string, uploadId: string): MarketingRecord[] {
  const now = new Date().toISOString();
  return rows.map((row) => ({
    ...row,
    id: crypto.randomUUID(),
    uploadId,
    source,
    sourceFile: filename,
    createdBy: actor,
    createdAt: now,
    deletedAt: null,
    deletedBy: null,
  }));
}

function requireDay(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(`${label} harus tanggal YYYY-MM-DD.`);
  const [year, month, day] = value.split("-").map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (stamp.getUTCFullYear() !== year || stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) {
    throw new AppError(`${label} tidak valid.`);
  }
  return value;
}

function assertRows(rows: Resolved[]) {
  for (const row of rows) {
    requireDay(row.periodStart, "Tanggal mulai");
    requireDay(row.periodEnd, "Tanggal selesai");
    if (!sameCalendarMonth(row.periodStart, row.periodEnd) || row.periodEnd < row.periodStart) {
      throw new AppError("Tanggal mulai dan selesai harus dalam bulan yang sama.");
    }
    if (!row.storeName.trim()) throw new AppError("Pilih toko.");
    if (!row.platform.trim()) throw new AppError("Pilih platform.");
  }
}

async function saveResolved(rows: Resolved[], source: SpendSource, filename: string, actor: string, overwrite: boolean): Promise<{ inserted: number; replaced: number }> {
  assertRows(rows);
  if (supabaseConfigured()) return saveResolvedRemote(rows, source, filename, actor, overwrite);
  return withFileLock(() => saveResolvedFile(rows, source, filename, actor, overwrite));
}

async function saveResolvedRemote(rows: Resolved[], source: SpendSource, filename: string, actor: string, overwrite: boolean): Promise<{ inserted: number; replaced: number }> {
  const uploadId = crypto.randomUUID();
  const created = materialize(rows, source, filename, actor, uploadId);
  const { data, error } = await client().rpc("marketing_apply", { p: {
    action: "save",
    actor,
    overwrite,
    uploadId,
    rows: created.map((row) => ({
      id: row.id,
      line_no: row.lineNo,
      period_start: row.periodStart,
      period_end: row.periodEnd,
      platform: row.platform,
      store_name: row.storeName,
      campaign: row.campaign,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      orders: row.orders,
      ads_revenue: row.adsRevenue,
      source: row.source,
      source_file: row.sourceFile,
      created_at: row.createdAt,
    })),
  } });
  if (error) schemaOrFail(error, "menyimpan marketing spending");
  const result = (data ?? {}) as { conflict?: boolean; inserted?: number; replaced?: number; duplicates?: { id: string; platform: string; storeName: string; periodStart: string; periodEnd: string }[] };
  if (result.conflict) {
    const groups = duplicateGroups((result.duplicates ?? []).map((row) => ({
      id: row.id, platform: row.platform, storeName: row.storeName, periodStart: row.periodStart, periodEnd: row.periodEnd,
    })), rows);
    throw new ConflictError(duplicateText(groups), groups);
  }
  return { inserted: Number(result.inserted ?? 0), replaced: Number(result.replaced ?? 0) };
}

async function saveResolvedFile(rows: Resolved[], source: SpendSource, filename: string, actor: string, overwrite: boolean): Promise<{ inserted: number; replaced: number }> {
  const active = await loadRows("active");
  const duplicates = duplicateGroups(spansOf(active), rows);
  if (duplicates.length && !overwrite) throw new ConflictError(duplicateText(duplicates), duplicates);
  const uploadId = crypto.randomUUID();
  const created = materialize(rows, source, filename, actor, uploadId);
  await insertRows(created);
  const oldIds = duplicates.flatMap((group) => group.ids);
  const oldRows = active.filter((row) => oldIds.includes(row.id));
  if (overwrite && oldIds.length) await markDeleted(oldIds, actor);
  await writeSpendAudit([
    ...oldRows.map((row) => ({
      spendId: row.id,
      uploadId,
      action: "overwrite" as const,
      actor,
      platform: row.platform,
      storeName: row.storeName,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      snapshot: row,
    })),
    {
      spendId: null,
      uploadId,
      action: "create" as const,
      actor,
      platform: rows[0]?.platform ?? "",
      storeName: rows[0]?.storeName ?? "",
      periodStart: rows.reduce((min, row) => row.periodStart < min ? row.periodStart : min, rows[0]?.periodStart ?? ""),
      periodEnd: rows.reduce((max, row) => row.periodEnd > max ? row.periodEnd : max, rows[0]?.periodEnd ?? ""),
      snapshot: { count: created.length, filename, source, ids: created.map((row) => row.id) },
    },
  ]);
  return { inserted: created.length, replaced: oldRows.length };
}

export async function commitUpload(input: { filename: string; buffer: Buffer; platform: string; storeName: string | null; stores: string[]; overwrite: boolean; actor: string }): Promise<{ inserted: number; replaced: number }> {
  const prepared = await prepareUpload(input);
  if (prepared.parsed.crossesMonth) throw new AppError(prepared.parsed.monthMessage || "Periode lintas bulan ditolak.");
  if (prepared.unresolved.length) {
    throw new AppError(prepared.parsed.kind === "template"
      ? `Toko tidak dikenali: ${prepared.unresolved.join(", ")}. Samakan dengan daftar toko di aplikasi.`
      : "Pilih toko. Nama di file tidak cocok dengan daftar toko.");
  }
  if (!prepared.rows.length) throw new AppError("Tidak ada baris valid untuk disimpan.");
  return saveResolved(prepared.rows, prepared.source, input.filename, input.actor, input.overwrite);
}

export async function addManual(input: {
  periodStart: string;
  periodEnd: string;
  platform: string;
  storeName: string;
  campaign: string;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  adsRevenue: number | null;
  stores: string[];
  overwrite: boolean;
  actor: string;
}): Promise<{ inserted: number; replaced: number }> {
  if (!sameCalendarMonth(input.periodStart, input.periodEnd) || input.periodEnd < input.periodStart) {
    throw new AppError("Tanggal mulai dan selesai harus dalam bulan yang sama.");
  }
  if (!isPlatform(input.platform)) throw new AppError("Platform tidak dikenal.");
  if (!Number.isFinite(input.spend)) throw new AppError("Isi spend.");
  const storeName = canonicalStore(input.storeName, input.stores);
  if (input.stores.length && !input.stores.some((store) => store.toLowerCase() === storeName.toLowerCase())) {
    throw new AppError(`Toko "${input.storeName}" tidak ada di daftar toko.`);
  }
  const row: Resolved = {
    lineNo: 1,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    platform: input.platform,
    storeRaw: input.storeName,
    storeName,
    campaign: input.campaign.trim(),
    spend: Math.round(input.spend * 100) / 100,
    impressions: input.impressions,
    clicks: input.clicks,
    orders: input.orders,
    adsRevenue: input.adsRevenue == null ? null : Math.round(input.adsRevenue * 100) / 100,
  };
  return saveResolved([row], "manual", "", input.actor, input.overwrite);
}

export async function softDeleteMarketing(ids: string[], actor: string): Promise<number> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return 0;
  if (supabaseConfigured()) {
    const { data, error } = await client().rpc("marketing_apply", { p: { action: "delete", actor, ids: unique } });
    if (error) schemaOrFail(error, "menghapus marketing spending");
    return Number((data as { replaced?: number } | null)?.replaced ?? 0);
  }
  return withFileLock(async () => {
    const active = await loadRows("active");
    const rows = active.filter((row) => unique.includes(row.id));
    await markDeleted(rows.map((row) => row.id), actor);
    await writeSpendAudit(rows.map((row) => ({
      spendId: row.id,
      uploadId: row.uploadId || null,
      action: "delete" as const,
      actor,
      platform: row.platform,
      storeName: row.storeName,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      snapshot: row,
    })));
    return rows.length;
  });
}
