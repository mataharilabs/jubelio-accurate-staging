import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { eachDay } from "@/lib/jubelio/adapter";
import { latestJob } from "@/lib/jubelio/jobs";
import { advancePull, startPull } from "@/lib/jubelio/runner";
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
    if (body.resume) {
      const current = await latestJob();
      if (!current) throw new AppError("Tidak ada tarikan untuk dilanjutkan.");
      const job = await advancePull(current.id);
      return NextResponse.json({ job });
    }
    if (!body.from || !body.to) throw new AppError("Isi tanggal dari dan sampai.");
    const job = await startPull("manual", session.email, eachDay(body.from, body.to));
    await recordAudit({ actorEmail: session.email, action: "jubelio.pull", entity: "jubelio_job", entityId: job.id, before: null, after: { from: body.from, to: body.to } });
    const advanced = await advancePull(job.id);
    return NextResponse.json({ job: advanced });
  } catch (error) {
    return fail(error);
  }
}
