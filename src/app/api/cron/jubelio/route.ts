import { after, NextResponse } from "next/server";
import { recentDays } from "@/lib/jubelio/adapter";
import { chainNext } from "@/lib/jubelio/chain";
import { advancePull, beginScheduledPull, continueRunning } from "@/lib/jubelio/runner";
import {
  DAILY_END_OFFSET,
  DAILY_START_OFFSET,
  isStepStale,
  shouldArmSuccessor,
  STEP_BUDGET_MS,
  WEEKLY_END_OFFSET,
  WEEKLY_START_OFFSET,
} from "@/lib/jubelio/schedule";

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
  const headerChain = Number(request.headers.get("x-job-chain") ?? "0");
  const chain = Number.isFinite(headerChain) && headerChain > 0 ? headerChain : 0;
  let busy = false;
  let running = false;
  let stale = false;
  try {
    const today = wibToday();
    const days = schedule === "weekly"
      ? recentDays(today, WEEKLY_START_OFFSET, WEEKLY_END_OFFSET)
      : recentDays(today, DAILY_START_OFFSET, DAILY_END_OFFSET);
    // Chain hits resume a stale running job or promote a queued job when nothing is running.
    // The daily and weekly crons are the only schedules, so this watchdog rides on them too.
    const job = chain === 0
      ? await beginScheduledPull(schedule, `cron:${schedule}`, days)
      : await continueRunning();
    if (!job) return { status: "idle" as const };
    const step = await advancePull(job.id, STEP_BUDGET_MS);
    busy = step.busy;
    if (step.busy) {
      stale = isStepStale(step.job.updatedAt, Date.now());
    } else {
      if (step.job.status !== "running") await continueRunning();
      const open = await continueRunning();
      running = Boolean(open);
      stale = open ? isStepStale(open.updatedAt, Date.now()) : false;
    }
    return { id: step.job.id, status: step.job.status, stats: step.job.stats, day: step.job.day, busy, chain };
  } finally {
    try {
      if (!running && !busy) {
        const open = await continueRunning();
        if (open) {
          running = true;
          stale = isStepStale(open.updatedAt, Date.now());
        }
      }
      if (shouldArmSuccessor({ busy, running, stale, chain })) {
        const secret = process.env.CRON_SECRET?.trim();
        const authorization = secret ? `Bearer ${secret}` : "";
        const chained = chainNext(url, authorization, chain, true, false);
        if (chained) await chained;
      }
    } catch {
      console.error("Rantai cron Jubelio ditolak (0).");
    }
  }
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
