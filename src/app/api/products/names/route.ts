import { NextResponse } from "next/server";
import { fail, requirePermission } from "@/lib/http";
import { advanceNameSync } from "@/lib/products/name-sync";
import { STEP_BUDGET_MS } from "@/lib/jubelio/schedule";

export const maxDuration = 300;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return (request.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  try {
    const cron = cronAuthorized(request);
    const session = cron ? null : await requirePermission("products.manage");
    const run = await advanceNameSync(STEP_BUDGET_MS, cron ? "cron" : "manual", session?.email ?? null);
    return NextResponse.json({
      id: run.id,
      status: run.status,
      changed: run.changedCount,
      fallback: run.fallbackCount,
      skipped: run.skippedCount,
      errors: run.errorCount,
      pending: run.pendingSkus.length,
      sample: run.sample,
      error: run.error,
    });
  } catch (error) {
    return fail(error);
  }
}
