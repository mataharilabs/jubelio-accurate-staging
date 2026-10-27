import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { accurateConfigured } from "@/lib/env";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    const store = await getStore();
    const dash = await store.dashboard();
    const tokens = await store.getTokens();
    return NextResponse.json({
      ...dash,
      storage: { mode: store.mode, ephemeral: store.ephemeral },
      accurate: { configured: accurateConfigured(), connected: Boolean(tokens?.accessToken) },
    });
  } catch (error) {
    return fail(error);
  }
}
