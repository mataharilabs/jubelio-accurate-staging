import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    return NextResponse.json(await (await getStore()).listReviews());
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = (await request.json()) as { id?: string };
    if (body.id) await (await getStore()).resolveReview(body.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
