import { after, NextResponse } from "next/server";
import { recentDays } from "@/lib/jubelio/adapter";
import { chainNext } from "@/lib/jubelio/chain";
import { advancePull, beginScheduledPull, continueRunning } from "@/lib/jubelio/runner";
import { STEP_BUDGET_MS } from "@/lib/jubelio/schedule";

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
  const chain = Number(request.headers.get("x-job-chain") ?? "0");
  const today = wibToday();
  const days = schedule === "weekly" ? recentDays(today, 28, 14) : recentDays(today, 7, 1);
  const job = chain === 0
    ? await beginScheduledPull(schedule, `cron:${schedule}`, days)
    : await continueRunning();
  if (!job) return { status: "idle" as const };
  const step = await advancePull(job.id, STEP_BUDGET_MS);
  if (!step.busy && step.job.status !== "running") await continueRunning();
  const running = step.busy ? false : Boolean(await continueRunning());
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = secret ? `Bearer ${secret}` : (request.headers.get("authorization") ?? "");
  const chained = chainNext(url, authorization, Number.isFinite(chain) && chain > 0 ? chain : 0, running, step.busy);
  if (chained) await chained;
  return { id: step.job.id, status: step.job.status, stats: step.job.stats, day: step.job.day, busy: step.busy, chain: Number.isFinite(chain) ? chain : 0 };
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
