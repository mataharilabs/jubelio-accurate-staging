import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { eachDay } from "@/lib/jubelio/adapter";
import { continueCron } from "@/lib/jubelio/chain";
import { latestJob } from "@/lib/jubelio/jobs";
import { advancePull, continueRunning, startPull } from "@/lib/jubelio/runner";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";

export const maxDuration = 300;

export async function GET() {
  try {
    await requirePermission("import.pull");
    return NextResponse.json({ job: await latestJob() });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePermission("import.pull");
    const body = (await request.json()) as { from?: string; to?: string; resume?: boolean };
    const job = body.resume
      ? await continueRunning()
      : await startPull("manual", session.email, requiredDays(body.from, body.to));
    if (!job) throw new AppError("Tidak ada tarikan untuk dilanjutkan.");
    if (!body.resume) {
      await recordAudit({ actorEmail: session.email, action: "jubelio.pull", entity: "jubelio_job", entityId: job.id, before: null, after: { from: body.from, to: body.to } });
    }
    const step = await advancePull(job.id);
    if (step.busy) throw new AppError("Tarikan sedang berjalan. Tunggu langkah ini selesai.", 409);
    if (step.job.status !== "running") await continueRunning();
    const running = Boolean(await continueRunning());
    const secret = process.env.CRON_SECRET?.trim();
    if (secret && running) {
      const origin = new URL(request.url).origin;
      continueCron(`${origin}/api/cron/jubelio?schedule=manual`, `Bearer ${secret}`, 0, true, false);
    }
    return NextResponse.json({ job: step.job });
  } catch (error) {
    return fail(error);
  }
}

function requiredDays(from?: string, to?: string): string[] {
  if (!from || !to) throw new AppError("Isi tanggal dari dan sampai.");
  return eachDay(from, to);
}
