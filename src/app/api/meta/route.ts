import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { accurateEnv, salesPushEnabled } from "@/lib/env";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    const store = await getStore();
    const [meta, settings] = await Promise.all([store.meta(), store.getSettings()]);
    return NextResponse.json({
      ...meta,
      salesPush: salesPushEnabled(),
      accurateDatabaseId: settings.accurateDatabaseId || accurateEnv().databaseId || "",
    });
  } catch (error) {
    return fail(error);
  }
}
