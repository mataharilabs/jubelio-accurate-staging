import { after, NextResponse } from "next/server";
import { openJobs } from "@/lib/jubelio/jobs";
import { advancePull, continueRunning } from "@/lib/jubelio/runner";
import { nextBackgroundTick, planContinue, STEP_BUDGET_MS } from "@/lib/jubelio/schedule";
import { advanceHppSync, planHppContinue } from "@/lib/products/hpp-sync";
import { advanceNameSync, planNameContinue } from "@/lib/products/name-sync";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function resumeOpen() {
  const job = await continueRunning();
  if (!job) return;
  const step = await advancePull(job.id, STEP_BUDGET_MS);
  if (!step.busy && step.job.status !== "running") await continueRunning();
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Cron tidak diizinkan." }, { status: 401 });
  const jobs = await openJobs();
  const jubelio = planContinue(jobs, Date.now());
  // HPP, then item names, only when no Jubelio job is running or queued.
  const hpp = jubelio === "idle" ? await planHppContinue() : "idle";
  const names = jubelio === "idle" && hpp === "idle" ? await planNameContinue() : "idle";
  const tick = nextBackgroundTick(jubelio, hpp, names);
  if (tick === "idle" || tick === "busy") return NextResponse.json({ status: tick });
  const task = tick === "hpp"
    ? advanceHppSync(STEP_BUDGET_MS).then(() => undefined)
    : tick === "names"
      ? advanceNameSync(STEP_BUDGET_MS).then(() => undefined)
      : resumeOpen();
  after(task);
  return NextResponse.json({ accepted: true });
}
