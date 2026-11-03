import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { effectiveCost, type CostPoint, type CostSource } from "@/lib/products/cost";

export type CatalogItem = { id: string; name: string; active: boolean };
export type ProductRow = {
  sku: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  brandId: string | null;
  brandName: string | null;
  active: boolean;
  accurateFound: "true" | "false" | "unknown";
  hpp: number | null;
  hppSource: CostSource | null;
  hppDate: string | null;
  firstSoldAt: string | null;
};
export type ProductQuery = { q?: string; categoryId?: string; brandId?: string; noHpp?: boolean; notInAccurate?: boolean; incomplete?: boolean };
export type HppRun = {
  id: string;
  status: "running" | "done" | "failed";
  trigger: "manual" | "cron";
  startedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  skuCount: number;
  okCount: number;
  notFoundCount: number;
  errorCount: number;
  error: string | null;
  pendingSkus: string[];
  leaseToken: string | null;
  leaseUntil: string | null;
};

type FileDb = { categories: CatalogItem[]; brands: CatalogItem[]; products: ProductRow[]; costs: CostPoint[]; runs: HppRun[] };
const FILE = path.join(process.cwd(), "data", "products.json");

function client(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

function fail(error: { message?: string; code?: string } | null, action: string): never {
  const text = error?.message ?? "";
  if (error?.code === "42P01" || error?.code === "PGRST202" || error?.code === "PGRST205" || /products|product_report|orders_page|does not exist|schema cache/i.test(text)) {
    throw new AppError("Jalankan supabase/migrations/0005_products.sql di SQL Editor.");
  }
  throw new AppError(text || `Gagal ${action}.`);
}

function readFile(): FileDb {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as FileDb;
    return { categories: parsed.categories ?? [], brands: parsed.brands ?? [], products: parsed.products ?? [], costs: parsed.costs ?? [], runs: parsed.runs ?? [] };
  } catch {
    return { categories: [], brands: [], products: [], costs: [], runs: [] };
  }
}

function writeFile(db: FileDb) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db));
}

function withCost(product: ProductRow, costs: CostPoint[]): ProductRow {
  const chosen = effectiveCost(costs.filter((row) => row.sku === product.sku));
  return { ...product, hpp: chosen?.unitCost ?? null, hppSource: chosen?.source ?? null, hppDate: chosen?.costDate ?? null };
}

export function wibDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function listCatalog(kind: "categories" | "brands"): Promise<CatalogItem[]> {
  if (!supabaseConfigured()) return readFile()[kind].slice().sort((a, b) => a.name.localeCompare(b.name, "id"));
  const { data, error } = await client().from(kind).select("id, name, active").order("name");
  if (error) fail(error, "membaca master");
  return (data ?? []).map((row) => ({ id: String(row.id), name: String(row.name), active: Boolean(row.active) }));
}

export async function saveCatalog(kind: "categories" | "brands", input: { id?: string; name: string; active?: boolean }, by: string | null): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new AppError("Nama tidak boleh kosong.");
  if (!supabaseConfigured()) {
    const db = readFile();
    const rows = db[kind];
    const existing = rows.find((row) => row.id === input.id || row.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.name = name;
      existing.active = input.active ?? existing.active;
    } else rows.push({ id: crypto.randomUUID(), name, active: input.active ?? true });
    writeFile(db);
    return;
  }
  const payload: { id?: string; name: string; active: boolean; created_by?: string | null } = { name, active: input.active ?? true };
  if (input.id) payload.id = input.id;
  else payload.created_by = by;
  const { error } = await client().from(kind).upsert(payload, { onConflict: "name" });
  if (error) fail(error, "menyimpan master");
}

function mapProduct(row: Record<string, unknown>, costs: { unit_cost?: number; source?: CostSource; cost_date?: string; fetched_at?: string }[] = []): ProductRow {
  const category = row.categories && typeof row.categories === "object" ? row.categories as { name?: string } : null;
  const brand = row.brands && typeof row.brands === "object" ? row.brands as { name?: string } : null;
  const base: ProductRow = {
    sku: String(row.sku),
    name: String(row.name ?? ""),
    categoryId: row.category_id ? String(row.category_id) : null,
    categoryName: category?.name ?? null,
    brandId: row.brand_id ? String(row.brand_id) : null,
    brandName: brand?.name ?? null,
    active: row.active !== false,
    accurateFound: row.accurate_found === "true" || row.accurate_found === "false" ? row.accurate_found : "unknown",
    hpp: null,
    hppSource: null,
    hppDate: null,
    firstSoldAt: row.first_sold_at ? String(row.first_sold_at).slice(0, 10) : null,
  };
  return withCost(base, costs.map((cost) => ({
    sku: base.sku,
    unitCost: Number(cost.unit_cost),
    source: cost.source === "manual" ? "manual" : "accurate",
    costDate: String(cost.cost_date).slice(0, 10),
    fetchedAt: String(cost.fetched_at ?? ""),
  })));
}

export function productIncomplete(row: ProductRow): boolean {
  return !row.name.trim() || !row.categoryId || !row.brandId;
}

export async function listProducts(query: ProductQuery = {}): Promise<ProductRow[]> {
  let rows: ProductRow[];
  if (!supabaseConfigured()) {
    const db = readFile();
    rows = db.products.map((row) => withCost(row, db.costs));
  } else {
    const { data, error } = await client().from("products").select("*, categories(name), brands(name), product_costs(unit_cost, source, cost_date, fetched_at)").order("sku");
    if (error) fail(error, "membaca produk");
    rows = (data ?? []).map((row) => mapProduct(row as Record<string, unknown>, (row.product_costs ?? []) as { unit_cost?: number; source?: CostSource; cost_date?: string; fetched_at?: string }[]));
  }
  const q = query.q?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (q && !`${row.sku} ${row.name}`.toLowerCase().includes(q)) return false;
    if (query.categoryId && row.categoryId !== query.categoryId) return false;
    if (query.brandId && row.brandId !== query.brandId) return false;
    if (query.noHpp && row.hpp != null) return false;
    if (query.notInAccurate && row.accurateFound !== "false") return false;
    if (query.incomplete && !productIncomplete(row)) return false;
    return true;
  });
}

export async function saveProduct(input: { sku: string; name: string; categoryId?: string | null; brandId?: string | null; active?: boolean }, by: string | null): Promise<void> {
  const sku = input.sku.trim();
  if (!sku) throw new AppError("SKU wajib diisi.");
  if (!supabaseConfigured()) {
    const db = readFile();
    const existing = db.products.find((row) => row.sku === sku);
    const next: ProductRow = {
      sku,
      name: input.name.trim() || existing?.name || sku,
      categoryId: input.categoryId !== undefined ? input.categoryId : existing?.categoryId ?? null,
      categoryName: db.categories.find((row) => row.id === (input.categoryId !== undefined ? input.categoryId : existing?.categoryId))?.name ?? existing?.categoryName ?? null,
      brandId: input.brandId !== undefined ? input.brandId : existing?.brandId ?? null,
      brandName: db.brands.find((row) => row.id === (input.brandId !== undefined ? input.brandId : existing?.brandId))?.name ?? existing?.brandName ?? null,
      active: input.active ?? true,
      accurateFound: existing?.accurateFound ?? "unknown",
      hpp: existing?.hpp ?? null,
      hppSource: existing?.hppSource ?? null,
      hppDate: existing?.hppDate ?? null,
      firstSoldAt: existing?.firstSoldAt ?? null,
    };
    db.products = existing ? db.products.map((row) => row.sku === sku ? next : row) : [...db.products, next];
    writeFile(db);
    return;
  }
  const payload: Record<string, unknown> = {
    sku,
    name: input.name.trim(),
    active: input.active ?? true,
    updated_at: new Date().toISOString(),
    updated_by: by,
  };
  if (input.categoryId !== undefined) payload.category_id = input.categoryId || null;
  if (input.brandId !== undefined) payload.brand_id = input.brandId || null;
  const { error } = await client().from("products").upsert(payload);
  if (error) fail(error, "menyimpan produk");
}

export async function saveManualCost(sku: string, unitCost: number, note: string, by: string | null): Promise<void> {
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new AppError("HPP tidak valid.");
  await saveProduct({ sku, name: (await listProducts({ q: sku })).find((row) => row.sku === sku)?.name ?? sku }, by);
  const point: CostPoint = { sku, costDate: wibDay(), unitCost, source: "manual", fetchedAt: new Date().toISOString() };
  if (!supabaseConfigured()) {
    const db = readFile();
    db.costs = db.costs.filter((row) => !(row.sku === sku && row.costDate === point.costDate && row.source === "manual"));
    db.costs.push(point);
    writeFile(db);
    return;
  }
  const { error } = await client().from("product_costs").upsert({
    sku, cost_date: point.costDate, unit_cost: unitCost, source: "manual", fetched_at: point.fetchedAt, note,
  }, { onConflict: "sku,cost_date,source" });
  if (error) fail(error, "menyimpan HPP manual");
}

export async function ensureProducts(lines: { sku: string; name: string }[]): Promise<string[]> {
  const incoming = new Map<string, string>();
  for (const line of lines) {
    const sku = line.sku.trim();
    if (!sku) continue;
    if (!incoming.has(sku) && line.name.trim()) incoming.set(sku, line.name.trim());
    else if (!incoming.has(sku)) incoming.set(sku, "");
  }
  if (!incoming.size) return [];
  const existing = new Set((await listProducts()).map((row) => row.sku));
  const created: string[] = [];
  for (const [sku, name] of incoming) {
    if (existing.has(sku)) continue;
    await saveProduct({ sku, name, active: true }, "jubelio");
    created.push(sku);
  }
  return created;
}

export async function productReport(payload: Record<string, unknown>): Promise<unknown> {
  if (!supabaseConfigured()) throw new AppError("Laporan produk memakai Postgres. Jalankan migrasi 0005 di Supabase.");
  const { data, error } = await client().rpc("product_report", { p: payload });
  if (error) fail(error, "menghitung laporan produk");
  return data;
}

export async function ordersFromSql(payload: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client().rpc("orders_page", { p: payload });
  if (error) fail(error, "membaca pesanan");
  return data;
}

function mapRun(row: Record<string, unknown>): HppRun {
  const status = row.status === "done" || row.status === "failed" ? row.status : "running";
  return {
    id: String(row.id),
    status,
    trigger: row.trigger === "cron" ? "cron" : "manual",
    startedBy: row.started_by ? String(row.started_by) : row.startedBy ? String(row.startedBy) : null,
    startedAt: String(row.started_at ?? row.startedAt),
    finishedAt: row.finished_at || row.finishedAt ? String(row.finished_at ?? row.finishedAt) : null,
    skuCount: Number(row.sku_count ?? row.skuCount ?? 0),
    okCount: Number(row.ok_count ?? row.okCount ?? 0),
    notFoundCount: Number(row.not_found_count ?? row.notFoundCount ?? 0),
    errorCount: Number(row.error_count ?? row.errorCount ?? 0),
    error: row.error ? String(row.error) : null,
    pendingSkus: Array.isArray(row.pending_skus) ? row.pending_skus.map(String) : Array.isArray(row.pendingSkus) ? row.pendingSkus.map(String) : [],
    leaseToken: row.lease_token || row.leaseToken ? String(row.lease_token ?? row.leaseToken) : null,
    leaseUntil: row.lease_until || row.leaseUntil ? String(row.lease_until ?? row.leaseUntil) : null,
  };
}

export async function latestHppRun(): Promise<HppRun | null> {
  if (!supabaseConfigured()) return readFile().runs[0] ?? null;
  const { data, error } = await client().from("hpp_sync_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) fail(error, "membaca sync HPP");
  return data ? mapRun(data as Record<string, unknown>) : null;
}

export async function saveHppRun(run: HppRun): Promise<void> {
  if (!supabaseConfigured()) {
    const db = readFile();
    db.runs = [run, ...db.runs.filter((row) => row.id !== run.id)].slice(0, 20);
    writeFile(db);
    return;
  }
  const { error } = await client().from("hpp_sync_runs").upsert({
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    started_by: run.startedBy,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    sku_count: run.skuCount,
    ok_count: run.okCount,
    not_found_count: run.notFoundCount,
    error_count: run.errorCount,
    error: run.error,
    pending_skus: run.pendingSkus,
    lease_token: run.leaseToken,
    lease_until: run.leaseUntil,
  });
  if (error) fail(error, "menyimpan sync HPP");
}

export async function recordAccurateCost(sku: string, unitCost: number, runId: string, found: boolean, itemId: string | null): Promise<void> {
  if (!supabaseConfigured()) {
    const db = readFile();
    const product = db.products.find((row) => row.sku === sku);
    if (product) product.accurateFound = found ? "true" : "false";
    if (found) {
      db.costs = db.costs.filter((row) => !(row.sku === sku && row.costDate === wibDay() && row.source === "accurate"));
      db.costs.push({ sku, costDate: wibDay(), unitCost, source: "accurate", fetchedAt: new Date().toISOString() });
    }
    writeFile(db);
    return;
  }
  const sb = client();
  const { error } = await sb.from("products").update({
    accurate_found: found ? "true" : "false",
    accurate_item_id: itemId,
    updated_at: new Date().toISOString(),
  }).eq("sku", sku);
  if (error) fail(error, "menandai produk Accurate");
  if (!found) return;
  const inserted = await sb.from("product_costs").upsert({
    sku, cost_date: wibDay(), unit_cost: unitCost, source: "accurate", fetched_at: new Date().toISOString(), sync_run_id: runId,
  }, { onConflict: "sku,cost_date,source" });
  if (inserted.error) fail(inserted.error, "menyimpan HPP Accurate");
}
