import { getStore } from "@/lib/db";
import { publishNotice } from "@/lib/access/store";
import { AppError } from "@/lib/errors";
import { DEFAULT_JUBELIO_LOCATIONS, orderToRawRows, wibDay, wibWindowUtc, type BundleRecord } from "@/lib/jubelio/adapter";
import { JubelioClient } from "@/lib/jubelio/client";
import { bundleMap, createJob, getJob, latestJob, saveBundles, saveJob, type PullJob } from "@/lib/jubelio/jobs";
import { rapikan } from "@/lib/cleanup/rapikan";
import { rapikanMaps } from "@/lib/sample-data";

const PAGE = 50;
const DETAILS = 8;

type ListResponse = { data?: Array<{ salesorder_id: number; transaction_date: string }>; totalCount?: number };

export async function startPull(trigger: string, actor: string, days: string[]): Promise<PullJob> {
  if (!days.length) throw new AppError("Pilih minimal satu tanggal.");
  const running = await latestJob();
  if (running?.status === "running") return running;
  return createJob(trigger, actor, days);
}

export async function advancePull(jobId: string, budgetMs = 45_000): Promise<PullJob> {
  const started = Date.now();
  let job = await getJob(jobId);
  if (!job) throw new AppError("Job Jubelio tidak ditemukan.");
  if (job.status !== "running") return job;
  const client = new JubelioClient();
  if (!client.configured()) {
    job.status = "failed";
    job.error = "JUBELIO_EMAIL dan JUBELIO_PASSWORD belum diisi.";
    await saveJob(job);
    await publishNotice({ kind: "cron", title: "Tarikan Jubelio gagal", body: job.error, data: { jobId } });
    return job;
  }
  try {
    while (Date.now() - started < budgetMs && job.status === "running") {
      const before = JSON.stringify({ day: job.day, page: job.page, pending: job.pendingIds.length, days: job.days.length, list: job.listDone });
      job = await step(job, client);
      await saveJob(job);
      if (job.status !== "running") break;
      if (before === JSON.stringify({ day: job.day, page: job.page, pending: job.pendingIds.length, days: job.days.length, list: job.listDone })) break;
    }
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Tarikan gagal.";
    await saveJob(job);
    await publishNotice({ kind: "cron", title: "Tarikan Jubelio gagal", body: job.error, data: { jobId } });
  }
  return job;
}

async function step(job: PullJob, client: JubelioClient): Promise<PullJob> {
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
  if (!job.listDone) return listPage(job, client);
  if (job.pendingIds.length) return detailChunk(job, client);
  job.day = null;
  return job;
}

async function listPage(job: PullJob, client: JubelioClient): Promise<PullJob> {
  const window = wibWindowUtc(job.day!);
  const data = await client.get<ListResponse>("/sales/v2/orders/", {
    page: job.page,
    page_size: PAGE,
    transaction_date_from: window.from,
    transaction_date_to: window.to,
    sort_by: "transaction_date",
    sort_direction: "ASC",
  });
  const rows = data.data ?? [];
  for (const row of rows) {
    if (wibDay(row.transaction_date) === job.day) job.pendingIds.push(row.salesorder_id);
  }
  if (rows.length < PAGE) job.listDone = true;
  else job.page += 1;
  return job;
}

async function detailChunk(job: PullJob, client: JubelioClient): Promise<PullJob> {
  const ids = job.pendingIds.slice(0, DETAILS);
  job.pendingIds = job.pendingIds.slice(ids.length);
  const orders: ApiOrderSafe[] = [];
  for (const id of ids) {
    try {
      orders.push(await client.get<ApiOrderSafe>(`/sales/orders/${id}`));
    } catch (error) {
      job.stats.failed += 1;
      job.error = error instanceof Error ? error.message : "Detail gagal.";
    }
  }
  const bundleIds = [...new Set(orders.flatMap((order) => (order.items ?? []).filter((item) => item.is_bundle && item.item_id).map((item) => item.item_id!)))];
  const known = await bundleMap(bundleIds);
  const missing = bundleIds.filter((id) => !known.has(id));
  const fresh: BundleRecord[] = [];
  for (const id of missing) {
    const detail = await client.get<ItemPayload>(`/inventory/items/${id}`);
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
    job.stats.orders += new Set(rawRows.map((row) => row.noPesanan)).size;
    job.stats.lines += rawRows.length;
    job.stats.newVersions += imported.newVersions;
    job.stats.reviews += imported.reviews;
    if (imported.reviews) {
      await publishNotice({ kind: "review", title: "Nilai belum terpetakan", body: `${imported.reviews} pasangan baru perlu review.`, data: { day: job.day } });
    }
  }
  return job;
}

type ApiOrderSafe = Parameters<typeof orderToRawRows>[0];
type ItemPayload = { bundles?: BundleRecord["bundles"] };
