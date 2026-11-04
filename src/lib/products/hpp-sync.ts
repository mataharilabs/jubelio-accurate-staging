import { publishNotice } from "@/lib/access/store";
import { accurateApiConfigured, accurateApiEnv, fetchNearestCost, openAccurateHost } from "@/lib/accurate/api-token";
import { AppError } from "@/lib/errors";
import { accurateTransDate, decodePending, encodePending, syncWork } from "@/lib/products/cost";
import { latestHppRun, listCostCoverage, listProducts, recordAccurateCost, saveHppRun, wibDay, type HppRun } from "@/lib/products/service";

const LEASE_MS = 45_000;
const CHUNK = 25;

async function queueFor(mode: "cron" | "gaps" | "refresh", now = new Date()): Promise<{ pending: string[]; months: string[] }> {
  const today = wibDay(now);
  const products = await listProducts();
  const covered = await listCostCoverage();
  const work = syncWork(today, products.map((row) => ({ sku: row.sku, accurateFound: row.accurateFound })), covered, mode);
  const months = [...new Set(work.map((row) => row.periodMonth))];
  return { pending: work.map(encodePending), months };
}

export async function hppSyncNeeded(now = new Date()): Promise<boolean> {
  if (!accurateApiConfigured()) return false;
  const current = await latestHppRun();
  if (current?.status === "running") return true;
  const queued = await queueFor("cron", now);
  return queued.pending.length > 0;
}

export async function beginHppSync(trigger: "manual" | "cron", by: string | null, options: { refreshAll?: boolean } = {}): Promise<HppRun> {
  const current = await latestHppRun();
  if (current?.status === "running" && current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) return current;
  const mode = trigger === "manual" && options.refreshAll ? "refresh" : trigger === "manual" ? "gaps" : "cron";
  const queued = current?.status === "running"
    ? { pending: current.pendingSkus, months: current.months }
    : await queueFor(mode);
  const run: HppRun = {
    id: current?.status === "running" ? current.id : crypto.randomUUID(),
    status: "running",
    trigger,
    startedBy: by,
    startedAt: current?.status === "running" ? current.startedAt : new Date().toISOString(),
    finishedAt: null,
    skuCount: current?.status === "running" ? current.skuCount : queued.pending.length,
    okCount: current?.status === "running" ? current.okCount : 0,
    notFoundCount: current?.status === "running" ? current.notFoundCount : 0,
    errorCount: current?.status === "running" ? current.errorCount : 0,
    error: queued.pending.length ? null : "Snapshot bulan ini sudah lengkap.",
    pendingSkus: queued.pending,
    months: queued.months,
    leaseToken: null,
    leaseUntil: null,
  };
  if (!queued.pending.length) {
    run.status = "done";
    run.finishedAt = new Date().toISOString();
    await saveHppRun(run);
    return run;
  }
  if (!accurateApiConfigured()) {
    run.status = "failed";
    run.error = "Accurate belum terhubung.";
    run.finishedAt = new Date().toISOString();
    run.pendingSkus = [];
    await saveHppRun(run);
    return run;
  }
  await saveHppRun(run);
  return run;
}

export async function advanceHppSync(budgetMs = 250_000): Promise<{ run: HppRun; busy: boolean }> {
  const token = crypto.randomUUID();
  let run = await latestHppRun();
  if (!run || run.status !== "running") run = await beginHppSync("cron", null);
  if (run.status !== "running") {
    if (run.error && run.error !== "Snapshot bulan ini sudah lengkap.") {
      await publishNotice({ kind: "hpp", title: "Sync HPP", body: run.error, data: { runId: run.id } });
    }
    return { run, busy: false };
  }
  if (run.leaseUntil && Date.parse(run.leaseUntil) > Date.now() && run.leaseToken && run.leaseToken !== token) return { run, busy: true };
  if (!accurateApiConfigured()) {
    run.status = "failed";
    run.error = "Accurate belum terhubung.";
    run.finishedAt = new Date().toISOString();
    await saveHppRun(run);
    return { run, busy: false };
  }
  run.leaseToken = token;
  run.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  await saveHppRun(run);
  const deadline = Date.now() + budgetMs;
  try {
    const env = accurateApiEnv();
    const host = await openAccurateHost(fetch, env.token, env.signatureKey);
    while (run.pendingSkus.length && Date.now() < deadline) {
      const slice = run.pendingSkus.slice(0, CHUNK);
      run.pendingSkus = run.pendingSkus.slice(slice.length);
      for (const encoded of slice) {
        const item = decodePending(encoded);
        if (!item) continue;
        try {
          const cost = await fetchNearestCost(fetch, host, env.token, env.signatureKey, item.sku, accurateTransDate(item.periodMonth));
          if (!cost.found || cost.unitCost == null) {
            await recordAccurateCost(item.sku, 0, run.id, false, cost.itemId, item.periodMonth);
            run.notFoundCount += 1;
          } else {
            await recordAccurateCost(item.sku, cost.unitCost, run.id, true, cost.itemId, item.periodMonth);
            run.okCount += 1;
          }
        } catch (error) {
          run.errorCount += 1;
          run.error = error instanceof Error ? error.message : "Gagal membaca HPP.";
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      run.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      await saveHppRun(run);
    }
    if (!run.pendingSkus.length) {
      run.status = "done";
      run.finishedAt = new Date().toISOString();
      run.error = run.errorCount ? run.error : null;
    }
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof AppError ? error.message : "Accurate belum terhubung.";
    run.finishedAt = new Date().toISOString();
  } finally {
    run.leaseToken = null;
    run.leaseUntil = null;
    await saveHppRun(run);
    if (run.status !== "running") {
      const body = run.status === "done"
        ? `${run.okCount} HPP diperbarui, ${run.notFoundCount} tidak ada di Accurate, ${run.errorCount} gagal.`
        : (run.error || "Sync HPP gagal.");
      await publishNotice({ kind: "hpp", title: run.status === "done" ? "Sync HPP selesai" : "Sync HPP gagal", body, data: { runId: run.id } });
    }
  }
  return { run, busy: false };
}
