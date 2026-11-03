import { publishNotice } from "@/lib/access/store";
import { accurateApiConfigured, accurateApiEnv, fetchNearestCost, openAccurateHost } from "@/lib/accurate/api-token";
import { AppError } from "@/lib/errors";
import { latestHppRun, listProducts, recordAccurateCost, saveHppRun, type HppRun } from "@/lib/products/service";

const LEASE_MS = 45_000;
const CHUNK = 25;

export async function beginHppSync(trigger: "manual" | "cron", by: string | null): Promise<HppRun> {
  const current = await latestHppRun();
  if (current?.status === "running" && current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) return current;
  const products = await listProducts();
  const run: HppRun = {
    id: current?.status === "running" ? current.id : crypto.randomUUID(),
    status: "running",
    trigger,
    startedBy: by,
    startedAt: current?.status === "running" ? current.startedAt : new Date().toISOString(),
    finishedAt: null,
    skuCount: products.length,
    okCount: current?.status === "running" ? current.okCount : 0,
    notFoundCount: current?.status === "running" ? current.notFoundCount : 0,
    errorCount: current?.status === "running" ? current.errorCount : 0,
    error: null,
    pendingSkus: current?.status === "running" ? current.pendingSkus : products.map((row) => row.sku),
    leaseToken: null,
    leaseUntil: null,
  };
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
    await publishNotice({ kind: "hpp", title: "Sync HPP", body: run.error || "Accurate belum terhubung.", data: { runId: run.id } });
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
      for (const sku of slice) {
        try {
          const cost = await fetchNearestCost(fetch, host, env.token, env.signatureKey, sku);
          if (!cost.found || cost.unitCost == null) {
            await recordAccurateCost(sku, 0, run.id, false, cost.itemId);
            run.notFoundCount += 1;
          } else {
            await recordAccurateCost(sku, cost.unitCost, run.id, true, cost.itemId);
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
