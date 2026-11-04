import { NextResponse } from "next/server";
import { fail, requirePermission } from "@/lib/http";
import { advanceHppSync, beginHppSync } from "@/lib/products/hpp-sync";
import { listHppRuns } from "@/lib/products/service";

export const maxDuration = 300;

export async function GET() {
  try {
    await requirePermission("products.view");
    const runs = await listHppRuns();
    return NextResponse.json({ run: runs[0] ?? null, runs, configured: Boolean(process.env.ACCURATE_API_TOKEN?.trim() && process.env.ACCURATE_SIGNATURE_KEY?.trim()) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePermission("hpp.sync");
    const body = await request.json().catch(() => ({})) as { refreshAll?: boolean };
    const run = await beginHppSync("manual", session.email, { refreshAll: body.refreshAll === true });
    if (run.status !== "running") return NextResponse.json({ run });
    // One step here. The 5-minute continue route takes the rest when no Jubelio job is open.
    const step = await advanceHppSync();
    return NextResponse.json({ run: step.run });
  } catch (error) {
    return fail(error);
  }
}
