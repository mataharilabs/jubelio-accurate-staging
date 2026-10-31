import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await requireSession();
    const days = (new URL(request.url).searchParams.get("days") ?? "").split(",").filter(Boolean);
    return NextResponse.json({ rows: await (await getStore()).syncReview(days) });
  } catch (error) {
    return fail(error);
  }
}
