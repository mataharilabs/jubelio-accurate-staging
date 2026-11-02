import { NextResponse } from "next/server";
import { recentDays } from "@/lib/jubelio/adapter";
import { advancePull, startPull } from "@/lib/jubelio/runner";
import { latestJob } from "@/lib/jubelio/jobs";

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

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Cron tidak diizinkan." }, { status: 401 });
  const schedule = new URL(request.url).searchParams.get("schedule") === "weekly" ? "weekly" : "daily";
  const today = wibToday();
  const days = schedule === "weekly" ? recentDays(today, 28, 14) : recentDays(today, 7, 1);
  const current = await latestJob();
  const job = current?.status === "running" ? current : await startPull(schedule, `cron:${schedule}`, days);
  const advanced = await advancePull(job.id);
  if (advanced.status === "running") {
    const chain = Number(request.headers.get("x-job-chain") ?? "0");
    if (chain < 12) {
      const url = new URL(request.url);
      void fetch(url, { headers: { authorization: request.headers.get("authorization") ?? "", "x-job-chain": String(chain + 1) } }).catch(() => undefined);
    }
  }
  return NextResponse.json({ id: advanced.id, status: advanced.status, stats: advanced.stats, day: advanced.day });
}
