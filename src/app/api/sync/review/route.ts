import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requirePermission } from "@/lib/http";
import { clampPageSize } from "@/lib/page-size";

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    await requirePermission("sync.view");
    const url = new URL(request.url);
    const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
    const result = await (await getStore()).syncReviewPage({
      page,
      pageSize: clampPageSize(url.searchParams.get("pageSize"), 25),
      q: url.searchParams.get("q") ?? "",
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
      store: url.searchParams.get("store") ?? "",
      channel: url.searchParams.get("channel") ?? "",
      reason: url.searchParams.get("reason") ?? "",
      action: url.searchParams.get("action") ?? "",
      days: (url.searchParams.get("days") ?? "").split(",").filter(Boolean),
    });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
