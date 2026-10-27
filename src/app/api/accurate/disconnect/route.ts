import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function POST() {
  try {
    await requireSession();
    await (await getStore()).saveTokens(null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
