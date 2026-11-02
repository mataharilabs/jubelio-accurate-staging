import { NextResponse } from "next/server";
import { listDatabases, refreshTokens, tokenNeedsRefresh } from "@/lib/accurate/client";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";

export async function GET() {
  try {
    await requirePermission("settings.manage");
    const store = await getStore();
    let tokens = await store.getTokens();
    if (!tokens?.accessToken) throw new AppError("Accurate belum terhubung.");
    if (tokenNeedsRefresh(tokens)) {
      tokens = await refreshTokens(tokens);
      await store.saveTokens(tokens);
    }
    const databases = await listDatabases(tokens.accessToken);
    return NextResponse.json({ databases });
  } catch (error) {
    return fail(error);
  }
}
