import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { chooseProductName, classifyNameUpdate, mayReplaceName, type ItemIdentity, type ProductSeed } from "@/lib/jubelio/item-name";
import { eachPage } from "@/lib/db/supabase-paging";
import { costForMonth, monthStart, type CostPoint, type CostSource } from "@/lib/products/cost";
import { matchesProductQuery, type ProductFilter } from "@/lib/products/query";
import { bundleProtectedSkus, supersededSkus } from "@/lib/products/superseded";

export type CatalogItem = { id: string; name: string; active: boolean; code?: string; note?: string; updatedAt?: string | null; updatedBy?: string | null };
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
  hppCarried: boolean;
  hppUpdatedAt?: string | null;
  firstSoldAt: string | null;
  jubelioItemId?: number | null;
  nameSource?: "item" | "line" | null;
  createdBy?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
};
export type ProductQuery = ProductFilter & { month?: string };
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
  months: string[];
  leaseToken: string | null;
  leaseUntil: string | null;
};

type FileDb = { categories: CatalogItem[]; brands: CatalogItem[]; products: ProductRow[]; costs: CostPoint[]; runs: HppRun[] };
const FILE = path.join(process.cwd(), "data", "products.json");
const STORE_FILE = path.join(process.cwd(), "data", "store-v2.json");
const SUPERSEDED_BY = "auto:superseded-sku";

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

function moveCatalogProducts(db: FileDb, kind: "categories" | "brands", id: string, replacementId?: string | null) {
  const field = kind === "brands" ? "brandId" : "categoryId";
  const used = db.products.filter((row) => row[field] === id);
  if (!used.length) return;
  const label = kind === "brands" ? "brand" : "kategori";
  if (!replacementId || replacementId === id) throw new AppError(`Pilih ${label} pengganti. ${used.length} produk masih memakainya.`);
  const rows = kind === "brands" ? db.brands : db.categories;
  const next = rows.find((row) => row.id === replacementId && row.active);
  if (!next) throw new AppError("Pengganti tidak ditemukan atau sudah dihapus.");
  for (const product of used) {
    product[field] = replacementId;
    if (field === "brandId") product.brandName = next.name;
    else product.categoryName = next.name;
  }
}

async function moveCatalogProductsRemote(kind: "categories" | "brands", id: string, replacementId?: string | null) {
  const column = kind === "brands" ? "brand_id" : "category_id";
  const label = kind === "brands" ? "brand" : "kategori";
  const { count, error } = await client().from("products").select("sku", { count: "exact", head: true }).eq(column, id);
  if (error) fail(error, "menghitung produk");
  if (!count) return;
  if (!replacementId || replacementId === id) throw new AppError(`Pilih ${label} pengganti. ${count} produk masih memakainya.`);
  const { error: moved } = await client().from("products").update({ [column]: replacementId }).eq(column, id);
  if (moved) fail(moved, "memindahkan produk");
}

function withCost(product: ProductRow, costs: CostPoint[], month: string): ProductRow {
  const chosen = costForMonth(costs.filter((row) => row.sku === product.sku), month);
  return {
    ...product,
    hpp: chosen.cost?.unitCost ?? null,
    hppSource: chosen.cost?.source ?? null,
    hppDate: chosen.cost?.periodMonth ?? null,
    hppCarried: chosen.carried,
    hppUpdatedAt: chosen.cost ? chosen.cost.fetchedAt || null : null,
  };
}

export function wibDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function mapCatalog(row: Record<string, unknown>): CatalogItem {
  return {
    id: String(row.id),
    name: String(row.name),
    active: Boolean(row.active),
    code: row.code == null ? "" : String(row.code),
    note: row.note == null ? "" : String(row.note),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
  };
}

export async function listCatalog(kind: "categories" | "brands"): Promise<CatalogItem[]> {
  if (!supabaseConfigured()) return readFile()[kind].slice().sort((a, b) => a.name.localeCompare(b.name, "id"));
  const columns = kind === "brands"
    ? "id, name, active, code, updated_at, updated_by"
    : "id, name, active, note, updated_at, updated_by";
  const full = await client().from(kind).select(columns).order("name");
  if (full.error && /column|schema cache|does not exist/i.test(full.error.message ?? "")) {
    const basic = await client().from(kind).select("id, name, active").order("name");
    if (basic.error) fail(basic.error, "membaca master");
    return (basic.data ?? []).map((row) => mapCatalog(row as Record<string, unknown>));
  }
  if (full.error) fail(full.error, "membaca master");
  return (full.data ?? []).map((row) => mapCatalog(row as Record<string, unknown>));
}

export async function saveCatalog(kind: "categories" | "brands", input: { id?: string; name: string; active?: boolean; replacementId?: string | null; code?: string; note?: string }, by: string | null): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new AppError("Nama tidak boleh kosong.");
  const now = new Date().toISOString();
  if (!supabaseConfigured()) {
    const db = readFile();
    const rows = db[kind];
    const existing = rows.find((row) => row.id === input.id || row.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (input.active === false) moveCatalogProducts(db, kind, existing.id, input.replacementId);
      existing.name = name;
      existing.active = input.active ?? existing.active;
      if (input.code !== undefined) existing.code = input.code.trim();
      if (input.note !== undefined) existing.note = input.note.trim();
      existing.updatedAt = now;
      existing.updatedBy = by;
    } else rows.push({ id: crypto.randomUUID(), name, active: input.active ?? true, code: input.code?.trim() ?? "", note: input.note?.trim() ?? "", updatedAt: now, updatedBy: by });
    writeFile(db);
    return;
  }
  if (input.active === false && input.id) await moveCatalogProductsRemote(kind, input.id, input.replacementId);
  const payload: Record<string, unknown> = { name, active: input.active ?? true, updated_at: now, updated_by: by };
  if (input.id) payload.id = input.id;
  else payload.created_by = by;
  if (kind === "brands" && input.code !== undefined) payload.code = input.code.trim();
  if (kind === "categories" && input.note !== undefined) payload.note = input.note.trim();
  const { error } = await client().from(kind).upsert(payload, { onConflict: "name" });
  if (error && /column|schema cache|does not exist/i.test(error.message ?? "")) {
    const slim: Record<string, unknown> = { name, active: input.active ?? true };
    if (input.id) slim.id = input.id;
    else slim.created_by = by;
    const again = await client().from(kind).upsert(slim, { onConflict: "name" });
    if (again.error) fail(again.error, "menyimpan master");
    return;
  }
  if (error) fail(error, "menyimpan master");
}

function mapProduct(row: Record<string, unknown>, costs: { unit_cost?: number; source?: CostSource; period_month?: string; fetched_at?: string }[] = [], month = wibMonth()): ProductRow {
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
    hppCarried: false,
    firstSoldAt: row.first_sold_at ? String(row.first_sold_at).slice(0, 10) : null,
  };
  return withCost(base, costs.map((cost) => ({
    sku: base.sku,
    unitCost: Number(cost.unit_cost),
    source: cost.source === "manual" ? "manual" : "accurate",
    periodMonth: monthStart(String(cost.period_month ?? month)),
    fetchedAt: String(cost.fetched_at ?? ""),
  })), month);
}

export function productIncomplete(row: ProductRow): boolean {
  return !row.name.trim() || !row.categoryId || !row.brandId;
}

export function wibMonth(now = new Date()): string {
  return monthStart(wibDay(now));
}

async function loadOrderedSkus(): Promise<Set<string>> {
  if (!supabaseConfigured()) {
    const { getStore } = await import("@/lib/db");
    const store = await getStore();
    return new Set(await store.listOrderedSkus());
  }
  const { data, error } = await client().rpc("ordered_skus");
  if (error) {
    if (error.code === "PGRST202" || /ordered_skus|schema cache|does not exist/i.test(error.message ?? "")) {
      throw new AppError("Jalankan supabase/migrations/0011_product_names_bundle_weights.sql di SQL Editor.");
    }
    fail(error, "membaca SKU pesanan");
  }
  const skus = new Set<string>();
  for (const row of Array.isArray(data) ? data : []) {
    if (typeof row === "string" && row) skus.add(row);
    else if (row && typeof row === "object" && "sku" in row) {
      const sku = String((row as { sku?: unknown }).sku ?? "");
      if (sku) skus.add(sku);
    }
  }
  return skus;
}

export async function listProducts(query: ProductQuery = {}): Promise<ProductRow[]> {
  const month = monthStart(query.month || wibMonth());
  let rows: ProductRow[];
  if (!supabaseConfigured()) {
    const db = readFile();
    rows = db.products.map((row) => withCost({ ...row, hppCarried: false }, db.costs, month));
  } else {
    let request = client().from("products").select("*, categories(name), brands(name), product_costs(unit_cost, source, period_month, fetched_at)").order("sku");
    if (query.brandId === "none") request = request.is("brand_id", null);
    else if (query.brandId) request = request.eq("brand_id", query.brandId);
    if (query.categoryId === "none") request = request.is("category_id", null);
    else if (query.categoryId) request = request.eq("category_id", query.categoryId);
    const { data, error } = await request;
    if (error) fail(error, "membaca produk");
    rows = (data ?? []).map((row) => mapProduct(row as Record<string, unknown>, (row.product_costs ?? []) as { unit_cost?: number; source?: CostSource; period_month?: string; fetched_at?: string }[], month));
  }
  const ordered = query.ordered ? await loadOrderedSkus() : null;
  return rows.filter((row) => matchesProductQuery(row, query, ordered));
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
      hppCarried: existing?.hppCarried ?? false,
      firstSoldAt: existing?.firstSoldAt ?? null,
      jubelioItemId: existing?.jubelioItemId ?? null,
      nameSource: existing?.nameSource ?? null,
      createdBy: existing?.createdBy ?? null,
      updatedAt: existing?.updatedAt ?? null,
      updatedBy: by,
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

export async function saveManualCost(sku: string, unitCost: number, note: string, by: string | null, periodMonth = wibMonth()): Promise<void> {
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new AppError("HPP tidak valid.");
  await saveProduct({ sku, name: (await listProducts({ q: sku })).find((row) => row.sku === sku)?.name ?? sku }, by);
  const point: CostPoint = { sku, periodMonth: monthStart(periodMonth), unitCost, source: "manual", fetchedAt: new Date().toISOString() };
  if (!supabaseConfigured()) {
    const db = readFile();
    db.costs = db.costs.filter((row) => !(row.sku === sku && row.periodMonth === point.periodMonth && row.source === "manual"));
    db.costs.push(point);
    writeFile(db);
    return;
  }
  const { error } = await client().from("product_costs").upsert({
    sku, period_month: point.periodMonth, unit_cost: unitCost, source: "manual", fetched_at: point.fetchedAt, note,
  }, { onConflict: "sku,period_month,source" });
  if (error) fail(error, "menyimpan HPP manual");
}

export type ItemLookup = {
  byId(itemId: number): Promise<ItemIdentity | null>;
  byCode(sku: string): Promise<ItemIdentity | null>;
};

export async function ensureProducts(lines: ProductSeed[], lookup?: ItemLookup): Promise<string[]> {
  const incoming = new Map<string, ProductSeed>();
  for (const line of lines) {
    const sku = line.sku.trim();
    if (!sku || incoming.has(sku)) continue;
    incoming.set(sku, { sku, lineName: line.lineName.trim(), itemId: line.itemId });
  }
  if (!incoming.size) return [];
  const existing = new Set((await listProducts()).map((row) => row.sku));
  const created: string[] = [];
  for (const seed of incoming.values()) {
    if (existing.has(seed.sku)) continue;
    try {
      let master: ItemIdentity | null = null;
      if (lookup && seed.itemId) master = await lookup.byId(seed.itemId);
      if (lookup && !master?.name) {
        const byCode = await lookup.byCode(seed.sku);
        if (byCode) master = { id: byCode.id, name: master?.name ?? byCode.name };
      }
      const chosen = chooseProductName({ masterName: master?.name ?? null, lineName: seed.lineName });
      await saveNamedProduct({ sku: seed.sku, name: chosen.name, itemId: master?.id ?? seed.itemId, source: chosen.source });
      created.push(seed.sku);
    } catch {
      try {
        await saveNamedProduct({ sku: seed.sku, name: seed.lineName, itemId: seed.itemId, source: "line" });
        created.push(seed.sku);
      } catch {
        // A product-table failure must not escape into the order import.
      }
    }
  }
  return created;
}

/** `active: true` only on insert. An existing row, including a soft-deleted SKU, keeps its flag. */
export function namedProductPayload(input: { sku: string; name: string; itemId: number | null; source: "item" | "line"; at: string }, existing: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sku: input.sku,
    name: input.name,
    jubelio_item_id: input.itemId,
    name_source: input.source,
    updated_by: "jubelio",
    updated_at: input.at,
  };
  if (!existing) payload.active = true;
  return payload;
}

export async function saveNamedProduct(input: { sku: string; name: string; itemId: number | null; source: "item" | "line" }): Promise<void> {
  const sku = input.sku.trim();
  if (!sku) return;
  const name = input.name.trim() || sku;
  const at = new Date().toISOString();
  if (!supabaseConfigured()) {
    const db = readFile();
    const existing = db.products.find((row) => row.sku === sku);
    const next: ProductRow = {
      sku,
      name,
      categoryId: existing?.categoryId ?? null,
      categoryName: existing?.categoryName ?? null,
      brandId: existing?.brandId ?? null,
      brandName: existing?.brandName ?? null,
      active: existing?.active ?? true,
      accurateFound: existing?.accurateFound ?? "unknown",
      hpp: existing?.hpp ?? null,
      hppSource: existing?.hppSource ?? null,
      hppDate: existing?.hppDate ?? null,
      hppCarried: existing?.hppCarried ?? false,
      firstSoldAt: existing?.firstSoldAt ?? null,
      jubelioItemId: input.itemId,
      nameSource: input.source,
      createdBy: existing?.createdBy ?? null,
      updatedAt: at,
      updatedBy: "jubelio",
    };
    db.products = existing ? db.products.map((row) => row.sku === sku ? next : row) : [...db.products, next];
    writeFile(db);
    return;
  }
  const found = await client().from("products").select("sku").eq("sku", sku).maybeSingle();
  if (found.error) fail(found.error, "membaca produk");
  const payload = namedProductPayload({ sku, name, itemId: input.itemId, source: input.source, at }, Boolean(found.data));
  const wrote = await client().from("products").upsert(payload);
  if (!wrote.error) return;
  if (!/name_source|schema cache/i.test(wrote.error.message ?? "")) fail(wrote.error, "menyimpan nama produk");
  const retryBody: Record<string, unknown> = {
    sku: payload.sku,
    name: payload.name,
    jubelio_item_id: payload.jubelio_item_id,
    updated_by: payload.updated_by,
    updated_at: payload.updated_at,
  };
  if ("active" in payload) retryBody.active = payload.active;
  const retry = await client().from("products").upsert(retryBody);
  if (retry.error) fail(retry.error, "menyimpan nama produk");
}

type SkuFact = { sku: string; createdBy: string | null; active: boolean; accurateFound: string | null };

function accurateValue(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

/** Current versions include data_status deleted. Only an explicit is_current false is historical. */
function skuUsage(lines: { sku: string; current: boolean | null }[]): { historical: Set<string>; current: Set<string> } {
  const historical = new Set<string>();
  const current = new Set<string>();
  for (const line of lines) {
    const sku = line.sku.trim();
    if (!sku || line.current == null) continue;
    (line.current ? current : historical).add(sku);
  }
  return { historical, current };
}

function readLocalOrderFacts(): {
  lines: { sku: string; current: boolean | null }[];
  components: { bundleSku: string; componentSku: string }[];
  bundleKeys: string[];
} {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf8")) as {
      version?: number;
      versions?: { isCurrent?: boolean; lines?: { sku?: string }[] }[];
      weights?: { bundleKey?: string }[];
      bundleComponents?: { bundleSku?: string; sku?: string }[];
    };
    if (parsed.version !== 2) return { lines: [], components: [], bundleKeys: [] };
    const lines: { sku: string; current: boolean | null }[] = [];
    for (const version of parsed.versions ?? []) {
      const current = version.isCurrent === true ? true : version.isCurrent === false ? false : null;
      for (const line of version.lines ?? []) lines.push({ sku: String(line.sku ?? ""), current });
    }
    return {
      lines,
      components: (parsed.bundleComponents ?? []).map((row) => ({ bundleSku: String(row.bundleSku ?? ""), componentSku: String(row.sku ?? "") })),
      bundleKeys: (parsed.weights ?? []).map((row) => String(row.bundleKey ?? "")),
    };
  } catch {
    return { lines: [], components: [], bundleKeys: [] };
  }
}

async function pageQuery<T>(
  action: string,
  load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string; code?: string } | null }>,
): Promise<T[]> {
  return eachPage(async (from, to) => {
    const { data, error } = await load(from, to);
    if (error) fail(error, action);
    return data ?? [];
  });
}

/**
 * Soft-delete auto-created products whose SKU remains only on non-current order versions.
 * A later Jubelio version replaced that SKU. Never-ordered, current (including deleted),
 * costed, Accurate-matched, and bundle SKUs stay. Does not hard-delete or edit orders.
 */
export async function deactivateSupersededProducts(): Promise<string[]> {
  const now = new Date().toISOString();
  if (!supabaseConfigured()) {
    const db = readFile();
    const facts = readLocalOrderFacts();
    const usage = skuUsage(facts.lines);
    const products: SkuFact[] = db.products.map((row) => ({
      sku: row.sku,
      createdBy: row.createdBy ?? null,
      active: row.active,
      accurateFound: row.accurateFound ?? null,
    }));
    const protectedSkus = bundleProtectedSkus(products.map((row) => row.sku), facts.components, facts.bundleKeys);
    const chosen = supersededSkus({
      products,
      costSkus: new Set(db.costs.map((row) => row.sku)),
      protectedSkus,
      historicalSkus: usage.historical,
      currentSkus: usage.current,
    });
    if (!chosen.length) return [];
    const drop = new Set(chosen);
    for (const product of db.products) {
      if (!drop.has(product.sku)) continue;
      product.active = false;
      product.updatedBy = SUPERSEDED_BY;
      product.updatedAt = now;
    }
    writeFile(db);
    return chosen.sort((a, b) => a.localeCompare(b, "en"));
  }

  const sb = client();
  const productRows = await pageQuery("membaca produk", (from, to) => sb.from("products").select("sku, created_by, active, accurate_found").eq("active", true).is("created_by", null).order("sku").range(from, to));
  const products: SkuFact[] = productRows.map((row) => ({
    sku: String(row.sku ?? ""),
    createdBy: row.created_by == null ? null : String(row.created_by),
    active: row.active !== false,
    accurateFound: accurateValue(row.accurate_found),
  })).filter((row) => row.sku);
  if (!products.length) return [];

  const costRows = await pageQuery("membaca HPP", (from, to) => sb.from("product_costs").select("sku").order("id").range(from, to));
  const componentRows = await pageQuery("membaca komponen bundle", async (from, to) => {
    const result = await sb.from("bundle_components").select("bundle_sku, component_sku").order("id").range(from, to);
    const text = result.error?.message ?? "";
    if (result.error && /bundle_components/i.test(text) && /does not exist|schema cache|PGRST/i.test(text)) {
      throw new AppError("Jalankan supabase/migrations/0011_product_names_bundle_weights.sql di SQL Editor.");
    }
    return result;
  });
  const weightRows = await pageQuery("membaca bobot bundle", (from, to) => sb.from("bundle_weights").select("bundle_key").order("id").range(from, to));
  const protectedSkus = bundleProtectedSkus(
    products.map((row) => row.sku),
    componentRows.map((row) => ({ bundleSku: String(row.bundle_sku ?? ""), componentSku: String(row.component_sku ?? "") })),
    weightRows.map((row) => String(row.bundle_key ?? "")),
  );
  const costSkus = new Set(costRows.map((row) => String(row.sku ?? "").trim()).filter(Boolean));
  const preliminary = products.filter((row) => !costSkus.has(row.sku) && !protectedSkus.has(row.sku) && (row.accurateFound == null || row.accurateFound === "false" || row.accurateFound === "unknown"));
  const usage = skuUsage(await orderLineUsage(sb, preliminary.map((row) => row.sku)));
  const chosen = supersededSkus({
    products: preliminary,
    costSkus,
    protectedSkus,
    historicalSkus: usage.historical,
    currentSkus: usage.current,
  });
  if (!chosen.length) return [];

  const updated: string[] = [];
  for (let i = 0; i < chosen.length; i += 100) {
    const chunk = chosen.slice(i, i + 100);
    const { data, error } = await sb.from("products").update({
      active: false,
      updated_by: SUPERSEDED_BY,
      updated_at: now,
    }).in("sku", chunk).eq("active", true).is("created_by", null).select("sku");
    if (error) fail(error, "menonaktifkan SKU tergantikan");
    for (const row of data ?? []) {
      const sku = String(row.sku ?? "").trim();
      if (sku) updated.push(sku);
    }
  }
  return updated.sort((a, b) => a.localeCompare(b, "en"));
}

async function orderLineUsage(sb: SupabaseClient, skus: string[]): Promise<{ sku: string; current: boolean | null }[]> {
  const wanted = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
  if (!wanted.length) return [];
  const currentIds = new Set((await pageQuery("membaca versi pesanan", (from, to) => sb.from("order_versions").select("id").eq("is_current", true).order("id").range(from, to))).map((row) => String(row.id)));
  const historicalIds = new Set((await pageQuery("membaca versi pesanan", (from, to) => sb.from("order_versions").select("id").eq("is_current", false).order("id").range(from, to))).map((row) => String(row.id)));
  const lines: { sku: string; current: boolean | null }[] = [];
  for (let i = 0; i < wanted.length; i += 40) {
    const chunk = wanted.slice(i, i + 40);
    const rows = await pageQuery("membaca baris pesanan", (from, to) => sb.from("order_lines").select("sku, version_id").in("sku", chunk).order("id").range(from, to));
    for (const row of rows) {
      const versionId = String(row.version_id ?? "");
      const current = currentIds.has(versionId) ? true : historicalIds.has(versionId) ? false : null;
      lines.push({ sku: String(row.sku ?? ""), current });
    }
  }
  return lines;
}

export type NameTarget = { sku: string; name: string; updatedBy: string | null; jubelioItemId: number | null; nameSource: "item" | "line" | null };

export async function listNameTargets(): Promise<NameTarget[]> {
  if (!supabaseConfigured()) {
    return readFile().products
      .filter((row) => row.active !== false && mayReplaceName(row.updatedBy) && (row.nameSource == null || (row.nameSource === "line" && row.jubelioItemId == null)))
      .map((row) => ({ sku: row.sku, name: row.name, updatedBy: row.updatedBy ?? null, jubelioItemId: row.jubelioItemId ?? null, nameSource: row.nameSource ?? null }));
  }
  const { data, error } = await client().from("products").select("sku, name, updated_by, jubelio_item_id, name_source, active").order("sku");
  if (error) {
    if (/name_source|schema cache/i.test(error.message ?? "")) throw new AppError("Jalankan supabase/migrations/0007_product_names.sql di SQL Editor.");
    fail(error, "membaca nama produk");
  }
  return (data ?? []).flatMap((row) => {
    if (row.active === false) return [];
    const updatedBy = row.updated_by ? String(row.updated_by) : null;
    const nameSource = row.name_source === "item" || row.name_source === "line" ? row.name_source : null;
    const needsLookup = nameSource == null || (nameSource === "line" && row.jubelio_item_id == null);
    if (!needsLookup || !mayReplaceName(updatedBy)) return [];
    return [{ sku: String(row.sku), name: String(row.name ?? ""), updatedBy, jubelioItemId: row.jubelio_item_id == null ? null : Number(row.jubelio_item_id), nameSource }];
  });
}

export async function readNameTarget(sku: string): Promise<NameTarget | null> {
  const rows = await listNameTargets();
  return rows.find((row) => row.sku === sku) ?? null;
}

export async function applyItemName(input: { sku: string; name: string; itemId: number | null; source: "item" | "line" }): Promise<"changed" | "fallback" | "unchanged" | "skipped"> {
  const current = await readNameTarget(input.sku);
  if (!current || !mayReplaceName(current.updatedBy)) return "skipped";
  const before = current.name;
  const nextName = input.name.trim() || before;
  const outcome = classifyNameUpdate(
    { name: before, itemId: current.jubelioItemId },
    { name: nextName, itemId: input.itemId, source: input.source },
  );
  if (outcome === "unchanged" && current.nameSource === input.source) return "unchanged";
  if (!supabaseConfigured()) {
    await saveNamedProduct({ ...input, name: nextName });
  } else {
    const { error } = await client().from("products").update({
      name: nextName,
      jubelio_item_id: input.itemId,
      name_source: input.source,
      updated_by: "jubelio",
      updated_at: new Date().toISOString(),
    }).eq("sku", input.sku);
    if (error) {
      if (/name_source|schema cache/i.test(error.message ?? "")) throw new AppError("Jalankan supabase/migrations/0007_product_names.sql di SQL Editor.");
      fail(error, "menyimpan nama produk");
    }
  }
  return outcome;
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
    months: Array.isArray(row.months) ? row.months.map(String) : [],
    leaseToken: row.lease_token || row.leaseToken ? String(row.lease_token ?? row.leaseToken) : null,
    leaseUntil: row.lease_until || row.leaseUntil ? String(row.lease_until ?? row.leaseUntil) : null,
  };
}

export async function listHppRuns(limit = 8): Promise<HppRun[]> {
  if (!supabaseConfigured()) return readFile().runs.slice(0, limit);
  const { data, error } = await client().from("hpp_sync_runs").select("*").order("started_at", { ascending: false }).limit(limit);
  if (error) fail(error, "membaca sync HPP");
  return (data ?? []).map((row) => mapRun(row as Record<string, unknown>));
}

export async function latestHppRun(): Promise<HppRun | null> {
  const runs = await listHppRuns(1);
  return runs[0] ?? null;
}

export async function listCostCoverage(): Promise<{ sku: string; periodMonth: string }[]> {
  if (!supabaseConfigured()) {
    return readFile().costs.map((row) => ({ sku: row.sku, periodMonth: monthStart(row.periodMonth) }));
  }
  const { data, error } = await client().from("product_costs").select("sku, period_month");
  if (error) fail(error, "membaca snapshot HPP");
  return (data ?? []).map((row) => ({ sku: String(row.sku), periodMonth: monthStart(String(row.period_month)) }));
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
    months: run.months,
    lease_token: run.leaseToken,
    lease_until: run.leaseUntil,
  });
  if (error) fail(error, "menyimpan sync HPP");
}

export async function recordAccurateCost(sku: string, unitCost: number, runId: string, found: boolean, itemId: string | null, periodMonth: string): Promise<void> {
  const month = monthStart(periodMonth);
  if (!supabaseConfigured()) {
    const db = readFile();
    const product = db.products.find((row) => row.sku === sku);
    if (product) product.accurateFound = found ? "true" : "false";
    if (found) {
      db.costs = db.costs.filter((row) => !(row.sku === sku && row.periodMonth === month));
      db.costs.push({ sku, periodMonth: month, unitCost, source: "accurate", fetchedAt: new Date().toISOString() });
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
  await sb.from("product_costs").delete().eq("sku", sku).eq("period_month", month).eq("source", "manual");
  const inserted = await sb.from("product_costs").upsert({
    sku, period_month: month, unit_cost: unitCost, source: "accurate", fetched_at: new Date().toISOString(), sync_run_id: runId,
  }, { onConflict: "sku,period_month,source" });
  if (inserted.error) fail(inserted.error, "menyimpan HPP Accurate");
}
