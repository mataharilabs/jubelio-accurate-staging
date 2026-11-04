import { after, NextResponse } from "next/server";
import { openJobs } from "@/lib/jubelio/jobs";
import { advancePull, continueRunning } from "@/lib/jubelio/runner";
import { planContinue, STEP_BUDGET_MS } from "@/lib/jubelio/schedule";

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
  const action = planContinue(jobs, Date.now());
  // Idle and busy return before waitUntil, so a tick with nothing to do stays cheap.
  if (action !== "resume") return NextResponse.json({ status: action });
  const task = resumeOpen();
  after(task);
  return NextResponse.json({ accepted: true });
}
