import { describe, expect, it } from "vitest";
import {
  CLAIM_WAIT_MS,
  DAILY_END_OFFSET,
  DAILY_START_OFFSET,
  FUNCTION_LIMIT_MS,
  LEASE_MS,
  MAX_CHAIN,
  STALE_JOB_MS,
  STALE_STEP_MS,
  STEP_BUDGET_MS,
  WEEKLY_END_OFFSET,
  WEEKLY_START_OFFSET,
  YIELD_MS,
  canClaim,
  detailBatchSize,
  CONTINUE_INTERVAL_MS,
  isStepStale,
  orchestrate,
  nextBackgroundTick,
  planContinue,
  shouldContinueChain,
  shouldPersistImport,
  type ScheduleJob,
} from "@/lib/jubelio/schedule";
import { recentDays } from "@/lib/jubelio/adapter";

function job(partial: Partial<ScheduleJob> & Pick<ScheduleJob, "id" | "status" | "days">): ScheduleJob {
  return {
    trigger: partial.trigger ?? "daily",
    createdAt: partial.createdAt ?? "2026-11-03T09:00:00.000Z",
    ...partial,
  };
}

describe("jubelio cron schedule", () => {
  it("fits H-1..H-3 plus H-4..H-28 inside the step cap and the Sunday-to-Monday gap", () => {
    expect(STEP_BUDGET_MS + YIELD_MS).toBeLessThanOrEqual(FUNCTION_LIMIT_MS - 30_000);
    expect(YIELD_MS).toBeLessThan(STEP_BUDGET_MS);
    expect(LEASE_MS).toBeGreaterThan(CLAIM_WAIT_MS);
    expect(LEASE_MS).toBeLessThan(STALE_STEP_MS);
    expect(CONTINUE_INTERVAL_MS).toBe(5 * 60_000);
    const minutesPerDay = 6;
    const dailyMinutes = (DAILY_START_OFFSET - DAILY_END_OFFSET + 1) * minutesPerDay;
    const weeklyMinutes = (WEEKLY_START_OFFSET - WEEKLY_END_OFFSET + 1) * minutesPerDay;
    const steps = Math.ceil(((dailyMinutes + weeklyMinutes) * 60_000) / STEP_BUDGET_MS);
    expect(steps).toBeLessThanOrEqual(MAX_CHAIN);
    const sundayToMondayDailyMs = ((16 * 60) + 1) * 60_000;
    expect(steps * CONTINUE_INTERVAL_MS).toBeLessThan(sundayToMondayDailyMs);
  });

  it("covers H-1 through H-28 with the daily and weekly windows", () => {
    const today = "2026-11-04";
    const daily = recentDays(today, DAILY_START_OFFSET, DAILY_END_OFFSET);
    const weekly = recentDays(today, WEEKLY_START_OFFSET, WEEKLY_END_OFFSET);
    expect(daily).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(weekly).toHaveLength(25);
    expect(weekly[0]).toBe("2026-10-07");
    expect(weekly[24]).toBe("2026-10-31");
    const middle = recentDays(today, 13, 4);
    const covered = new Set([...daily, ...weekly]);
    expect(middle.every((day) => covered.has(day))).toBe(true);
    expect(daily.some((day) => weekly.includes(day))).toBe(false);
  });

  it("starts a window when nothing is open", () => {
    const plan = orchestrate([], { trigger: "daily", days: ["2026-11-02"] }, Date.parse("2026-11-03T09:00:00.000Z"));
    expect(plan.start?.days).toEqual(["2026-11-02"]);
    expect(plan.enqueue).toBeNull();
    expect(plan.advanceId).toBeNull();
  });

  it("queues a weekly window behind a running daily job instead of taking it over", () => {
    const now = Date.parse("2026-11-02T16:59:00.000Z");
    const plan = orchestrate(
      [job({ id: "daily", status: "running", trigger: "daily", days: ["2026-10-26", "2026-11-01"], createdAt: "2026-11-02T09:00:00.000Z" })],
      { trigger: "weekly", days: ["2026-10-05", "2026-10-19"] },
      now,
    );
    expect(plan.advanceId).toBe("daily");
    expect(plan.enqueue?.trigger).toBe("weekly");
    expect(plan.start).toBeNull();
    expect(plan.failIds).toEqual([]);
  });

  it("does not enqueue the same window twice", () => {
    const now = Date.parse("2026-11-03T09:00:00.000Z");
    const days = ["2026-11-02", "2026-10-27"];
    const plan = orchestrate([job({ id: "daily", status: "running", days })], { trigger: "daily", days: [...days].reverse() }, now);
    expect(plan.enqueue).toBeNull();
    expect(plan.advanceId).toBe("daily");
  });

  it("promotes a queued weekly job and keeps a new daily window behind it", () => {
    const now = Date.parse("2026-11-03T09:05:00.000Z");
    const plan = orchestrate(
      [job({ id: "weekly", status: "queued", trigger: "weekly", days: ["2026-10-06"], createdAt: "2026-11-02T16:59:00.000Z" })],
      { trigger: "daily", days: ["2026-11-02"] },
      now,
    );
    expect(plan.promoteId).toBe("weekly");
    expect(plan.advanceId).toBe("weekly");
    expect(plan.enqueue?.trigger).toBe("daily");
    expect(plan.start).toBeNull();
  });

  it("fails a running job older than 36 hours so later schedules are not blocked", () => {
    const now = Date.parse("2026-11-05T09:00:00.000Z");
    const createdAt = new Date(now - STALE_JOB_MS - 60_000).toISOString();
    const plan = orchestrate(
      [job({ id: "stuck", status: "running", days: ["2026-11-01"], createdAt })],
      { trigger: "daily", days: ["2026-11-04"] },
      now,
    );
    expect(plan.failIds).toEqual(["stuck"]);
    expect(plan.start?.days).toEqual(["2026-11-04"]);
    expect(plan.advanceId).toBeNull();
  });

  it("refuses a second worker while the lease is held and allows a claim after it expires", () => {
    const now = Date.parse("2026-11-03T09:10:00.000Z");
    const held = { status: "running", leaseToken: "owner", leaseUntil: new Date(now + 20_000).toISOString() };
    expect(canClaim(held, "other", now)).toBe("busy");
    expect(canClaim(held, "owner", now)).toBe("claim");
    expect(canClaim({ ...held, leaseUntil: new Date(now - 1).toISOString() }, "other", now)).toBe("claim");
    expect(canClaim({ ...held, status: "done" }, "other", now)).toBe("closed");
  });

  it("chains only a live, unlocked step and stops at the Hobby chain cap", () => {
    expect(shouldContinueChain({ busy: false, running: true, chain: 0 })).toBe(true);
    expect(shouldContinueChain({ busy: true, running: true, chain: 0 })).toBe(false);
    expect(shouldContinueChain({ busy: false, running: false, chain: 0 })).toBe(false);
    expect(shouldContinueChain({ busy: false, running: true, chain: MAX_CHAIN })).toBe(false);
    expect(shouldContinueChain({ busy: false, running: true, chain: MAX_CHAIN - 1 })).toBe(true);
  });

  it("skips an import record when a batch did not create a version", () => {
    expect(shouldPersistImport(0)).toBe(false);
    expect(shouldPersistImport(2)).toBe(true);
  });

  it("shrinks the detail batch when little time is left in the step", () => {
    expect(detailBatchSize(STEP_BUDGET_MS)).toBe(4);
    expect(detailBatchSize(20_000)).toBe(1);
    expect(detailBatchSize(5_000)).toBe(1);
  });

  it("continues an open job and stays idle when nothing is running or queued", () => {
    const now = Date.parse("2026-11-03T10:43:27.000Z");
    const fresh = new Date(now - 60_000).toISOString();
    const quiet = new Date(now - STALE_STEP_MS - 1_000).toISOString();
    const held = new Date(now + 20_000).toISOString();
    expect(isStepStale(fresh, now)).toBe(false);
    expect(isStepStale(quiet, now)).toBe(true);
    expect(planContinue([], now)).toBe("idle");
    expect(planContinue([{ status: "queued", updatedAt: fresh, leaseUntil: null }], now)).toBe("resume");
    expect(planContinue([{ status: "running", updatedAt: fresh, leaseUntil: held }], now)).toBe("busy");
    expect(planContinue([{ status: "running", updatedAt: fresh, leaseUntil: null }], now)).toBe("resume");
    expect(planContinue([{ status: "running", updatedAt: quiet, leaseUntil: held }], now)).toBe("resume");
    expect(planContinue([{ status: "done", updatedAt: quiet, leaseUntil: null }], now)).toBe("idle");
  });

  it("runs HPP only after the Jubelio job is no longer open", () => {
    expect(nextBackgroundTick("resume", "resume")).toBe("jubelio");
    expect(nextBackgroundTick("busy", "resume")).toBe("busy");
    expect(nextBackgroundTick("idle", "resume")).toBe("hpp");
    expect(nextBackgroundTick("idle", "busy")).toBe("busy");
    expect(nextBackgroundTick("idle", "idle")).toBe("idle");
  });
});
