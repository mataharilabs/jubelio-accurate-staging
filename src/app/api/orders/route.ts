import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requirePermission } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await requirePermission("orders.view");
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "0");
    const result = await (await getStore()).listOrders({
      day: url.searchParams.get("day") || null,
      from: url.searchParams.get("from") || null,
      to: url.searchParams.get("to") || null,
      statuses: (url.searchParams.get("statuses") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      dataStatus: url.searchParams.get("dataStatus") === "deleted" || url.searchParams.get("dataStatus") === "all" ? url.searchParams.get("dataStatus") as "deleted" | "all" : "active",
      channels: (url.searchParams.get("channels") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      stores: (url.searchParams.get("stores") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      sync: url.searchParams.get("sync") === "need" || url.searchParams.get("sync") === "done" ? url.searchParams.get("sync") as "need" | "done" : "",
      q: url.searchParams.get("q") ?? "",
      page: Number.isFinite(page) ? page : 0,
      pageSize: 25,
    });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
