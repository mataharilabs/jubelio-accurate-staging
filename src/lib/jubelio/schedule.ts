/** Hobby plan: two cron triggers, each invocation capped at 300s. */

export const FUNCTION_LIMIT_MS = 300_000;
/**
 * Work budget inside one invocation. The dispatch of the next step happens
 * after this, and the whole invocation must stay under FUNCTION_LIMIT_MS.
 */
export const STEP_BUDGET_MS = 150_000;
/** Do not start another Jubelio call when less than this remains in the budget. */
export const YIELD_MS = 20_000;
/** A killed invocation stops refreshing this, so the next claimant is not locked out for long. */
export const LEASE_MS = 45_000;
/** How long a successor waits for the previous step's release to commit. */
export const CLAIM_WAIT_MS = 8_000;
/** Enough continuations for an H-1..H-3 daily pull plus an H-14..H-28 weekly window queued behind it. */
export const MAX_CHAIN = 60;
export const STALE_JOB_MS = 36 * 60 * 60 * 1000;
/** Resume a running job that has not saved for this long. The next cron or chain hit does it; there is no third cron. */
export const STALE_STEP_MS = 10 * 60 * 1000;
export const DETAIL_CHUNK = 4;
/** Daily cron re-pulls H-1 through H-3. H-4..H-13 is intentionally not covered. */
export const DAILY_START_OFFSET = 3;
export const DAILY_END_OFFSET = 1;
/** Sunday cron re-pulls H-14 through H-28. Do not widen this without raising MAX_CHAIN. */
export const WEEKLY_START_OFFSET = 28;
export const WEEKLY_END_OFFSET = 14;

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

export function isStepStale(updatedAt: string, now: number): boolean {
  const updated = Date.parse(updatedAt);
  return Number.isFinite(updated) && now - updated >= STALE_STEP_MS;
}

/**
 * The invocation that owns the step arms the next one when work remains.
 * A fresh lease held by that owner does not arm a second chain.
 * A running job that has not saved for STALE_STEP_MS arms a resume even if this hit found the lease busy.
 */
export function shouldArmSuccessor(input: { busy: boolean; running: boolean; stale: boolean; chain: number }): boolean {
  if (!Number.isFinite(input.chain) || input.chain < 0 || input.chain >= MAX_CHAIN) return false;
  if (input.busy && !input.stale) return false;
  return input.running || input.stale;
}

export function shouldPersistImport(newVersions: number): boolean {
  return newVersions > 0;
}

/** Fewer detail calls when the step is almost out of time, so the invocation can still chain. */
export function detailBatchSize(remainingMs: number): number {
  if (remainingMs < 15_000) return 1;
  return Math.min(DETAIL_CHUNK, Math.max(1, Math.floor(remainingMs / 12_000)));
}
