import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "0");
    const result = await (await getStore()).listOrders({
      day: url.searchParams.get("day") || null,
      q: url.searchParams.get("q") ?? "",
      page: Number.isFinite(page) ? page : 0,
      pageSize: 30,
    });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
