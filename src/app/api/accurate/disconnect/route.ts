import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requirePermission } from "@/lib/http";

export async function POST() {
  try {
    await requirePermission("settings.manage");
    await (await getStore()).saveTokens(null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
