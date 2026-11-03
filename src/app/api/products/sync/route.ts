import { NextResponse } from "next/server";
import { continueCron } from "@/lib/jubelio/chain";
import { fail, requirePermission } from "@/lib/http";
import { advanceHppSync, beginHppSync } from "@/lib/products/hpp-sync";
import { latestHppRun } from "@/lib/products/service";

export const maxDuration = 300;

export async function GET() {
  try {
    await requirePermission("products.view");
    return NextResponse.json({ run: await latestHppRun(), configured: Boolean(process.env.ACCURATE_API_TOKEN?.trim() && process.env.ACCURATE_SIGNATURE_KEY?.trim()) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePermission("hpp.sync");
    const run = await beginHppSync("manual", session.email);
    if (run.status !== "running") return NextResponse.json({ run });
    const step = await advanceHppSync();
    const secret = process.env.CRON_SECRET?.trim();
    if (secret && step.run.status === "running" && !step.busy) {
      continueCron(new URL("/api/cron/hpp", request.url).toString(), `Bearer ${secret}`, 0, true, false);
    }
    return NextResponse.json({ run: step.run });
  } catch (error) {
    return fail(error);
  }
}
