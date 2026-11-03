import { NextResponse } from "next/server";
import { continueCron } from "@/lib/jubelio/chain";
import { advanceHppSync } from "@/lib/products/hpp-sync";

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || authorization !== `Bearer ${secret}`) return NextResponse.json({ error: "Cron tidak diizinkan." }, { status: 401 });
  const chain = Number(request.headers.get("x-job-chain") ?? "0");
  const step = await advanceHppSync();
  const url = new URL(request.url);
  continueCron(url, authorization, Number.isFinite(chain) && chain > 0 ? chain : 0, step.run.status === "running", step.busy);
  return NextResponse.json({ id: step.run.id, status: step.run.status, error: step.run.error, pending: step.run.pendingSkus.length, busy: step.busy });
}
