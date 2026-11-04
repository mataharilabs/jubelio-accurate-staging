import { after, NextResponse } from "next/server";
import { recentDays } from "@/lib/jubelio/adapter";
import { advancePull, beginScheduledPull, continueRunning } from "@/lib/jubelio/runner";
import { DAILY_END_OFFSET, DAILY_START_OFFSET, STEP_BUDGET_MS, WEEKLY_END_OFFSET, WEEKLY_START_OFFSET } from "@/lib/jubelio/schedule";
import { beginHppSync, hppSyncNeeded } from "@/lib/products/hpp-sync";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

function wibToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function runCron(request: Request) {
  const url = new URL(request.url);
  const schedule = url.searchParams.get("schedule") === "weekly" ? "weekly" : "daily";
  const today = wibToday();
  const days = schedule === "weekly"
    ? recentDays(today, WEEKLY_START_OFFSET, WEEKLY_END_OFFSET)
    : recentDays(today, DAILY_START_OFFSET, DAILY_END_OFFSET);
  // Only the two Vercel crons reach this route. They are allowed to open a new window.
  const job = await beginScheduledPull(schedule, `cron:${schedule}`, days);
  if (!job) return { status: "idle" as const };
  const step = await advancePull(job.id, STEP_BUDGET_MS);
  if (!step.busy && step.job.status !== "running") await continueRunning();
  // HPP starts only once this daily pull, and anything queued behind it, is no longer running.
  // The 5-minute continue route does the HPP work. This process does not fetch itself.
  if (schedule === "daily" && !step.busy && !(await continueRunning()) && await hppSyncNeeded()) {
    await beginHppSync("cron", null);
  }
  return { id: step.job.id, status: step.job.status, stats: step.job.stats, day: step.job.day, busy: step.busy };
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Cron tidak diizinkan." }, { status: 401 });
  // The promise form of after() is registered with waitUntil immediately. The
  // response can return before the step finishes, so the caller is not held
  // open for the whole budget and the next invocation keeps its own budget.
  const task = runCron(request);
  after(task);
  return NextResponse.json({ accepted: true });
}
