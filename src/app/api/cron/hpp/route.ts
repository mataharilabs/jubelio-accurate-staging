import { NextResponse } from "next/server";
import { advanceHppSync } from "@/lib/products/hpp-sync";
import { STEP_BUDGET_MS } from "@/lib/jubelio/schedule";

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || authorization !== `Bearer ${secret}`) return NextResponse.json({ error: "Cron tidak diizinkan." }, { status: 401 });
  const step = await advanceHppSync(STEP_BUDGET_MS);
  return NextResponse.json({ id: step.run.id, status: step.run.status, error: step.run.error, pending: step.run.pendingSkus.length, busy: step.busy });
}
