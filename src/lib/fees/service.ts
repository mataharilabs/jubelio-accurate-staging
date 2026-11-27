import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors";
import { supabaseConfigured, supabaseServiceKey, supabaseUrl } from "@/lib/env";
import { applySalesLines } from "@/lib/fees/allocate";
import type { FeeDraft, Marketplace, PaymentDraft, SalesLine } from "@/lib/fees/types";

const CHUNK = 200;

function client(): SupabaseClient {
  if (!supabaseConfigured()) throw new AppError("Supabase belum dikonfigurasi.");
  return createClient(supabaseUrl(), supabaseServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

function missingMigration(error: { message?: string; code?: string } | null): boolean {
  const text = error?.message ?? "";
  return error?.code === "PGRST202" || error?.code === "42883" || error?.code === "42P01" || /fee_imports|order_fees|order_payments|fees_apply|payments_apply|payments_page|payment_order_lookup|match_fee_orders|fee_report|sku_fee_shares|does not exist|schema cache/i.test(text);
}

function explain(error: { message?: string; code?: string } | null, action: string): never {
  if (missingMigration(error)) throw new AppError("Jalankan supabase/migrations/0016_order_fees.sql di SQL Editor.");
  throw new AppError(error?.message || `Gagal ${action}.`);
}

export async function matchFeeOrders(keys: { noPesanan: string; orderId?: string }[]): Promise<{ matched: { input: string; resolved: string }[]; missing: string[] }> {
  const { data, error } = await client().rpc("match_fee_orders", {
    p: { keys: keys.map((key) => ({ no_pesanan: key.noPesanan, order_id: key.orderId ?? "" })) },
  });
  if (error) explain(error, "mencocokkan pesanan");
  const raw = (data ?? {}) as { matched?: { input: string; resolved: string }[]; missing?: string[] };
  return {
    matched: Array.isArray(raw.matched) ? raw.matched.map((row) => ({ input: String(row.input), resolved: String(row.resolved) })) : [],
    missing: Array.isArray(raw.missing) ? raw.missing.map(String) : [],
  };
}

export async function salesLines(orderNos: string[]): Promise<SalesLine[]> {
  const lines: SalesLine[] = [];
  for (let index = 0; index < orderNos.length; index += CHUNK) {
    const slice = orderNos.slice(index, index + CHUNK);
    const { data, error } = await client()
      .from("v_order_lines_master")
      .select("no_pesanan, sku, product_name, line_revenue, line_qty")
      .in("no_pesanan", slice);
    if (error) explain(error, "membaca baris pesanan");
    for (const row of data ?? []) {
      const item = row as { no_pesanan: string; sku: string; product_name: string; line_revenue: number | string | null; line_qty: number | string | null };
      lines.push({
        noPesanan: String(item.no_pesanan),
        sku: String(item.sku ?? ""),
        productName: String(item.product_name ?? ""),
        revenue: Number(item.line_revenue ?? 0),
        qty: Number(item.line_qty ?? 0),
      });
    }
  }
  return lines;
}

export async function applyFeeChunk(input: {
  importId: string;
  marketplace: Marketplace;
  format: string;
  fileName: string;
  actor: string;
  allocate: boolean;
  matchedOrders: number;
  unmatchedOrders: number;
  rows: FeeDraft[];
}): Promise<{ importId: string; inserted: number; replaced: number; skipped: number }> {
  const sales = input.allocate || input.rows.some((row) => !row.sku && row.productName)
    ? await salesLines([...new Set(input.rows.map((row) => row.noPesanan))])
    : [];
  const prepared = applySalesLines(input.rows, sales, input.allocate);
  const { data, error } = await client().rpc("fees_apply", {
    p: {
      importId: input.importId,
      marketplace: input.marketplace,
      format: input.format,
      fileName: input.fileName,
      actor: input.actor,
      source: input.marketplace === "template" ? "template" : "import",
      matchedOrders: input.matchedOrders,
      unmatchedOrders: input.unmatchedOrders,
      rows: prepared.map((row) => ({
        no_pesanan: row.noPesanan,
        sku: row.sku,
        fee_group: row.feeGroup,
        fee_name: row.feeName,
        amount_rp: row.amountRp,
        pct: row.pct,
        base: row.base,
        reduces_profit: row.reducesProfit,
        allocated: row.allocated,
      })),
    },
  });
  if (error) explain(error, "menyimpan biaya");
  const raw = (data ?? {}) as { importId?: string; inserted?: number; replaced?: number; skipped?: number };
  return {
    importId: String(raw.importId ?? input.importId),
    inserted: Number(raw.inserted ?? 0),
    replaced: Number(raw.replaced ?? 0),
    skipped: Number(raw.skipped ?? 0),
  };
}

export async function applyPayments(input: {
  actor: string;
  source: "manual" | "template";
  importId?: string;
  rows: PaymentDraft[];
}): Promise<{ inserted: number; replaced: number; skipped: number }> {
  const { data, error } = await client().rpc("payments_apply", {
    p: {
      action: "save",
      actor: input.actor,
      source: input.source,
      importId: input.importId ?? null,
      rows: input.rows.map((row) => ({
        no_pesanan: row.noPesanan,
        amount_rp: row.amountRp,
        paid_at: row.paidAt,
        method: row.method,
        note: row.note,
      })),
    },
  });
  if (error) explain(error, "menyimpan pembayaran");
  const raw = (data ?? {}) as { inserted?: number; replaced?: number; skipped?: number };
  return { inserted: Number(raw.inserted ?? 0), replaced: Number(raw.replaced ?? 0), skipped: Number(raw.skipped ?? 0) };
}

export async function deletePayments(actor: string, ids: string[]): Promise<{ replaced: number }> {
  const { data, error } = await client().rpc("payments_apply", { p: { action: "delete", actor, ids } });
  if (error) explain(error, "menghapus pembayaran");
  const raw = (data ?? {}) as { replaced?: number };
  return { replaced: Number(raw.replaced ?? 0) };
}

export type PaymentRow = {
  id: string;
  noPesanan: string;
  channel: string;
  storeName: string;
  net: number;
  amountRp: number;
  diff: number;
  paidAt: string;
  method: string;
  note: string;
  createdBy: string;
};

export async function listPayments(input: { q: string; page: number; pageSize: number }): Promise<{ total: number; page: number; pages: number; rows: PaymentRow[] }> {
  const { data, error } = await client().rpc("payments_page", { p: input });
  if (error) explain(error, "membaca pembayaran");
  const raw = (data ?? {}) as { total?: number; page?: number; pages?: number; rows?: PaymentRow[] };
  return {
    total: Number(raw.total ?? 0),
    page: Number(raw.page ?? 0),
    pages: Number(raw.pages ?? 1),
    rows: (raw.rows ?? []).map((row) => ({
      ...row,
      net: Number(row.net ?? 0),
      amountRp: Number(row.amountRp ?? 0),
      diff: Number(row.diff ?? 0),
    })),
  };
}

export type OrderLookup = {
  found: boolean;
  noPesanan?: string;
  channel?: string;
  storeName?: string;
  net?: number;
  cancelled?: boolean;
  paidVia?: "settlement" | "manual" | null;
  unpaid?: boolean;
};

export async function lookupPaymentOrder(noPesanan: string): Promise<OrderLookup> {
  const { data, error } = await client().rpc("payment_order_lookup", { p: { noPesanan } });
  if (error) explain(error, "mencari pesanan");
  const raw = (data ?? {}) as OrderLookup;
  return { ...raw, net: raw.net == null ? undefined : Number(raw.net) };
}

export type FeeReportKind = "affiliate" | "group" | "sku";

export async function feeReport(input: {
  kind: FeeReportKind;
  from: string | null;
  to: string | null;
  channels: string[];
  stores: string[];
  page: number;
  pageSize: number;
}): Promise<{ total: number; page: number; pages: number; rows: Record<string, unknown>[] }> {
  const { data, error } = await client().rpc("fee_report", { p: input });
  if (error) explain(error, "membaca laporan biaya");
  const raw = (data ?? {}) as { total?: number; page?: number; pages?: number; rows?: Record<string, unknown>[] };
  return {
    total: Number(raw.total ?? 0),
    page: Number(raw.page ?? 0),
    pages: Number(raw.pages ?? 1),
    rows: Array.isArray(raw.rows) ? raw.rows : [],
  };
}
