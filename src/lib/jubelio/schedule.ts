/** Hobby plan: two cron triggers, each invocation capped at 300s. */

export const FUNCTION_LIMIT_MS = 300_000;
/**
 * Work budget inside one invocation. The lease is released before the function
 * ends, and the whole invocation must stay under FUNCTION_LIMIT_MS.
 */
export const STEP_BUDGET_MS = 150_000;
/** Do not start another Jubelio call when less than this remains in the budget. */
export const YIELD_MS = 20_000;
/** A killed invocation stops refreshing this, so the next claimant is not locked out for long. */
export const LEASE_MS = 45_000;
/** How long a successor waits for the previous step's release to commit. */
export const CLAIM_WAIT_MS = 8_000;
/**
 * Headroom for one H-1..H-3 daily window plus one H-4..H-28 weekly window
 * at the 150s step size. The external continue job does not stop at this number.
 */
export const MAX_CHAIN = 100;
export const STALE_JOB_MS = 36 * 60 * 60 * 1000;
/** Resume a running job that has not saved for this long. */
export const STALE_STEP_MS = 10 * 60 * 1000;
/** Supabase pg_cron calls the continue route on this interval. It does not start a new window. */
export const CONTINUE_INTERVAL_MS = 5 * 60 * 1000;
export const DETAIL_CHUNK = 4;
/** Daily Vercel cron re-pulls H-1 through H-3. */
export const DAILY_START_OFFSET = 3;
export const DAILY_END_OFFSET = 1;
/** Sunday Vercel cron re-pulls H-4 through H-28, which closes the gap after the daily window. */
export const WEEKLY_START_OFFSET = 28;
export const WEEKLY_END_OFFSET = 4;

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

export type ContinueJob = {
  status: "queued" | "running" | "done" | "failed";
  updatedAt: string;
  leaseUntil: string | null;
};

/**
 * What the external continue hit may do. It never starts a new date window.
 * A fresh lease means another step is already working, so this hit stays cheap.
 */
/**
 * Jubelio wins the tick. HPP runs only when no Jubelio job is running or queued,
 * so it starts after the daily pull is no longer in progress.
 */
export function nextBackgroundTick(
  jubelio: "idle" | "busy" | "resume",
  hpp: "idle" | "busy" | "resume",
): "jubelio" | "hpp" | "idle" | "busy" {
  if (jubelio === "resume") return "jubelio";
  if (jubelio === "busy") return "busy";
  if (hpp === "resume") return "hpp";
  if (hpp === "busy") return "busy";
  return "idle";
}

export function planContinue(jobs: ContinueJob[], now: number): "idle" | "busy" | "resume" {
  const running = jobs.find((job) => job.status === "running");
  if (running) {
    const leaseHeld = Boolean(running.leaseUntil && Date.parse(running.leaseUntil) > now);
    if (leaseHeld && !isStepStale(running.updatedAt, now)) return "busy";
    return "resume";
  }
  if (jobs.some((job) => job.status === "queued")) return "resume";
  return "idle";
}

export function shouldPersistImport(newVersions: number): boolean {
  return newVersions > 0;
}

/** Fewer detail calls when the step is almost out of time, so the invocation can still chain. */
export function detailBatchSize(remainingMs: number): number {
  if (remainingMs < 15_000) return 1;
  return Math.min(DETAIL_CHUNK, Math.max(1, Math.floor(remainingMs / 12_000)));
}
