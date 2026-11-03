import { getStore } from "@/lib/db";
import { publishNotice } from "@/lib/access/store";
import { AppError } from "@/lib/errors";
import { DEFAULT_JUBELIO_LOCATIONS, orderToRawRows, wibDay, wibWindowUtc, type BundleRecord } from "@/lib/jubelio/adapter";
import { JubelioClient } from "@/lib/jubelio/client";
import {
  activeRunning,
  claimJob,
  createJob,
  failJob,
  getJob,
  markRunning,
  openJobs,
  promoteNext,
  releaseJob,
  saveBundles,
  saveJob,
  scheduleView,
  bundleMap,
  type PullJob,
} from "@/lib/jubelio/jobs";
import { CLAIM_WAIT_MS, detailBatchSize, LEASE_MS, orchestrate, STEP_BUDGET_MS, YIELD_MS } from "@/lib/jubelio/schedule";
import { rapikan } from "@/lib/cleanup/rapikan";
import { rapikanMaps } from "@/lib/sample-data";

const PAGE = 50;

type ListResponse = { data?: Array<{ salesorder_id: number; transaction_date: string }>; totalCount?: number };

export type PullStep = { job: PullJob; busy: boolean };

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message === "Waktu langkah habis." || message.startsWith("Jubelio membatasi");
}

export async function beginScheduledPull(trigger: string, actor: string, days: string[]): Promise<PullJob | null> {
  if (!days.length) throw new AppError("Pilih minimal satu tanggal.");
  const plan = orchestrate((await openJobs()).map(scheduleView), { trigger, days }, Date.now());
  for (const id of plan.failIds) {
    await failJob(id, "Tarikan terhenti lebih dari 36 jam dan ditutup agar jadwal berikutnya jalan.");
    await publishNotice({
      kind: "cron",
      title: "Tarikan Jubelio ditutup",
      body: "Job berjalan lebih dari 36 jam dan ditutup agar jadwal baru tidak tertahan.",
      data: { jobId: id },
    });
  }
  if (plan.enqueue) await createJob(plan.enqueue.trigger, actor, plan.enqueue.days, "queued");
  if (plan.start) {
    const created = await createJob(plan.start.trigger, actor, plan.start.days, "queued");
    return (await markRunning(created.id)) ?? created;
  }
  if (plan.promoteId) {
    const promoted = await markRunning(plan.promoteId);
    if (promoted) return promoted;
  }
  if (plan.advanceId) return getJob(plan.advanceId);
  return activeRunning();
}

export async function startPull(trigger: string, actor: string, days: string[]): Promise<PullJob> {
  const job = await beginScheduledPull(trigger, actor, days);
  if (!job) throw new AppError("Tarikan tidak bisa dimulai.");
  return job;
}

export async function advancePull(jobId: string, budgetMs = STEP_BUDGET_MS): Promise<PullStep> {
  const token = crypto.randomUUID();
  const claimed = await claimWithRetry(jobId, token);
  if (!claimed.job) throw new AppError("Job Jubelio tidak ditemukan.");
  if (!claimed.owned) return { job: claimed.job, busy: claimed.job.status === "running" };
  let job = claimed.job;
  const deadline = Date.now() + budgetMs;
  try {
    const client = new JubelioClient();
    if (!client.configured()) {
      job.status = "failed";
      job.error = "JUBELIO_EMAIL dan JUBELIO_PASSWORD belum diisi.";
      await saveJob(job);
      await publishNotice({ kind: "cron", title: "Tarikan Jubelio gagal", body: job.error, data: { jobId } });
      return { job, busy: false };
    }
    while (Date.now() + YIELD_MS < deadline && job.status === "running") {
      const before = JSON.stringify({ day: job.day, page: job.page, pending: job.pendingIds.length, days: job.days.length, list: job.listDone });
      job = await step(job, client, deadline);
      job.leaseToken = token;
      job.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      await saveJob(job);
      if (job.status !== "running") break;
      if (before === JSON.stringify({ day: job.day, page: job.page, pending: job.pendingIds.length, days: job.days.length, list: job.listDone })) break;
    }
  } catch (error) {
    if (retryable(error)) {
      job.error = error instanceof Error ? error.message : "Tarikan dijeda.";
      job.leaseToken = token;
      await saveJob(job);
    } else {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Tarikan gagal.";
      job.leaseToken = token;
      await saveJob(job);
      await publishNotice({ kind: "cron", title: "Tarikan Jubelio gagal", body: job.error, data: { jobId } });
    }
  } finally {
    await releaseJob(jobId, token);
  }
  const fresh = await getJob(jobId);
  return { job: fresh ?? job, busy: false };
}

async function claimWithRetry(jobId: string, token: string): Promise<{ job: PullJob | null; owned: boolean }> {
  const giveUp = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    const claimed = await claimJob(jobId, token);
    if (claimed) return { job: claimed, owned: true };
    const current = await getJob(jobId);
    if (!current || current.status !== "running" || Date.now() >= giveUp) return { job: current, owned: false };
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export async function continueRunning(): Promise<PullJob | null> {
  return (await activeRunning()) ?? promoteNext();
}

async function step(job: PullJob, client: JubelioClient, deadline: number): Promise<PullJob> {
  if (!job.day) {
    const next = job.days[0];
    if (!next) {
      job.status = "done";
      await publishNotice({
        kind: "pull",
        title: "Tarikan Jubelio selesai",
        body: `${job.stats.orders} pesanan, ${job.stats.newVersions} versi baru, ${job.stats.reviews} perlu review, ${job.stats.failed} gagal.`,
        data: { jobId: job.id, trigger: job.trigger, ...job.stats },
      });
      return job;
    }
    job.day = next;
    job.days = job.days.slice(1);
    job.page = 1;
    job.listDone = false;
    job.pendingIds = [];
    return job;
  }
  if (!job.listDone) return listPage(job, client, deadline);
  if (job.pendingIds.length) return detailChunk(job, client, deadline);
  job.day = null;
  return job;
}

async function listPage(job: PullJob, client: JubelioClient, deadline: number): Promise<PullJob> {
  const window = wibWindowUtc(job.day!);
  const data = await client.get<ListResponse>("/sales/v2/orders/", {
    page: job.page,
    page_size: PAGE,
    transaction_date_from: window.from,
    transaction_date_to: window.to,
    sort_by: "transaction_date",
    sort_direction: "ASC",
  }, deadline);
  const rows = data.data ?? [];
  for (const row of rows) {
    if (wibDay(row.transaction_date) === job.day) job.pendingIds.push(row.salesorder_id);
  }
  if (rows.length < PAGE) job.listDone = true;
  else job.page += 1;
  return job;
}

async function detailChunk(job: PullJob, client: JubelioClient, deadline: number): Promise<PullJob> {
  const count = detailBatchSize(deadline - Date.now());
  const ids = job.pendingIds.slice(0, count);
  job.pendingIds = job.pendingIds.slice(ids.length);
  try {
    const orders: ApiOrderSafe[] = [];
    for (const id of ids) {
      try {
        orders.push(await client.get<ApiOrderSafe>(`/sales/orders/${id}`, undefined, deadline));
      } catch (error) {
        if (retryable(error)) throw error;
        job.stats.failed += 1;
        job.error = error instanceof Error ? error.message : "Detail gagal.";
      }
    }
    const bundleIds = [...new Set(orders.flatMap((order) => (order.items ?? []).filter((item) => item.is_bundle && item.item_id).map((item) => item.item_id!)))];
    const known = await bundleMap(bundleIds);
    const missing = bundleIds.filter((id) => !known.has(id));
    const fresh: BundleRecord[] = [];
    for (const id of missing) {
      const detail = await client.get<ItemPayload>(`/inventory/items/${id}`, undefined, deadline);
      const record: BundleRecord = {
        item_id: id,
        bundles: (detail.bundles ?? []).map((item) => ({
          item_id: item.item_id,
          item_code: item.item_code,
          item_name: item.item_name,
          qty: item.qty,
          qty_in_base: item.qty_in_base,
        })),
      };
      fresh.push(record);
      known.set(id, record);
    }
    await saveBundles(fresh);
    const store = await getStore();
    const settings = await store.getSettings();
    const locations = settings.jubelioLocations?.length ? settings.jubelioLocations : DEFAULT_JUBELIO_LOCATIONS;
    const maps = await rapikanMaps(store);
    const rawRows = orders.flatMap((order) => orderToRawRows(order, known, { date: job.day, locations }).rows);
    if (rawRows.length) {
      const cleaned = rapikan(rawRows, maps, { from: job.day, to: job.day });
      const imported = await store.importRawLines(cleaned.lines, cleaned.droppedCancels, `jubelio:${job.day}`, job.triggeredBy, { from: job.day, to: job.day }, "api");
    try {
      const { ensureProducts } = await import("@/lib/products/service");
      const { publishNotice: notify } = await import("@/lib/access/store");
      const created = await ensureProducts(cleaned.lines.map((line) => ({ sku: line.sku, name: line.productName })));
      if (created.length) await notify({ kind: "product", title: "Produk baru belum lengkap", body: `${created.length} SKU baru ditambahkan tanpa kategori atau brand.`, data: { skus: created.slice(0, 20) } });
    } catch {
      // Product tables arrive with migration 0005. A missing table must not fail the order import.
    }
      job.stats.orders += new Set(rawRows.map((row) => row.noPesanan)).size;
      job.stats.lines += rawRows.length;
      job.stats.newVersions += imported.newVersions;
      job.stats.reviews += imported.reviews;
      if (imported.reviews) {
        await publishNotice({ kind: "review", title: "Nilai belum terpetakan", body: `${imported.reviews} pasangan baru perlu review.`, data: { day: job.day } });
      }
    }
    return job;
  } catch (error) {
    job.pendingIds = [...ids, ...job.pendingIds];
    if (!retryable(error)) throw error;
    job.error = error instanceof Error ? error.message : "Detail dijeda.";
    return job;
  }
}

type ApiOrderSafe = Parameters<typeof orderToRawRows>[0];
type ItemPayload = { bundles?: BundleRecord["bundles"] };
