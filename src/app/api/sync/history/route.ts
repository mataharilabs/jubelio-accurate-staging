import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await requireSession();
    const store = await getStore();
    const no = new URL(request.url).searchParams.get("no");
    if (no) return NextResponse.json(await store.orderHistory(no));
    return NextResponse.json(await store.syncHistory());
  } catch (error) {
    return fail(error);
  }
}
