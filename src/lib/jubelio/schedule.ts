/** Hobby plan: one cron trigger per day, each invocation capped at 300s. */

export const FUNCTION_LIMIT_MS = 300_000;
/** Stop the step early so the lease can be released and the next invocation dispatched. */
export const STEP_BUDGET_MS = 250_000;
/** A killed invocation stops refreshing this, so the next claimant is not locked out for long. */
export const LEASE_MS = 45_000;
/** How long a successor waits for the previous step's release to commit. */
export const CLAIM_WAIT_MS = 8_000;
/** Enough continuations for a slow 7-day pull plus a weekly window queued behind it. */
export const MAX_CHAIN = 60;
export const STALE_JOB_MS = 36 * 60 * 60 * 1000;
export const DETAIL_CHUNK = 8;

export type ScheduleJob = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  trigger: string;
  days: string[];
  createdAt: string;
};

export type Orchestration = {
  failIds: string[];
  enqueue: { trigger: string; days: string[] } | null;
  promoteId: string | null;
  start: { trigger: string; days: string[] } | null;
  advanceId: string | null;
};

export function windowKey(days: string[]): string {
  return [...days].sort().join("|");
}

/**
 * Decides what a new daily, weekly, or manual request should do.
 * A different window is queued behind the running job. A job still marked
 * running after 36 hours is failed so it cannot block later schedules.
 */
export function orchestrate(jobs: ScheduleJob[], incoming: { trigger: string; days: string[] }, now: number): Orchestration {
  const running = jobs.filter((job) => job.status === "running").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const staleIds = new Set(running.filter((job) => now - Date.parse(job.createdAt) > STALE_JOB_MS).map((job) => job.id));
  const live = running.filter((job) => !staleIds.has(job.id));
  const queued = jobs.filter((job) => job.status === "queued" && !staleIds.has(job.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const key = windowKey(incoming.days);
  const already = [...live, ...queued].some((job) => windowKey(job.days) === key);
  const enqueue = already ? null : { trigger: incoming.trigger, days: incoming.days };
  if (live.length) {
    return { failIds: [...staleIds], enqueue, promoteId: null, start: null, advanceId: live[0].id };
  }
  if (queued.length) {
    const next = queued[0];
    return {
      failIds: [...staleIds],
      enqueue: enqueue && windowKey(next.days) === key ? null : enqueue,
      promoteId: next.id,
      start: null,
      advanceId: next.id,
    };
  }
  return { failIds: [...staleIds], enqueue: null, promoteId: null, start: { trigger: incoming.trigger, days: incoming.days }, advanceId: null };
}

export function canClaim(job: { status: string; leaseUntil: string | null; leaseToken: string | null }, token: string, now: number): "claim" | "busy" | "closed" {
  if (job.status !== "running") return "closed";
  if (job.leaseUntil && Date.parse(job.leaseUntil) > now) {
    return job.leaseToken === token ? "claim" : "busy";
  }
  return "claim";
}

export function shouldContinueChain(input: { busy: boolean; running: boolean; chain: number }): boolean {
  return !input.busy && input.running && Number.isFinite(input.chain) && input.chain >= 0 && input.chain < MAX_CHAIN;
}

export function shouldPersistImport(newVersions: number): boolean {
  return newVersions > 0;
}

/** Fewer detail calls when the step is almost out of time, so the invocation can still chain. */
export function detailBatchSize(remainingMs: number): number {
  if (remainingMs < 15_000) return 1;
  return Math.min(DETAIL_CHUNK, Math.max(1, Math.floor(remainingMs / 12_000)));
}
