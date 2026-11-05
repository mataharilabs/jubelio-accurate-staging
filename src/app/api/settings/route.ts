import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import type { AppSettings } from "@/lib/db/types";
import { accurateConfigured, accurateEnv, missingAccurateEnv, salesPushEnabled } from "@/lib/env";
import { recordAudit } from "@/lib/access/store";
import { fail, requirePermission } from "@/lib/http";

export async function GET() {
  try {
    await requirePermission("settings.manage");
    const store = await getStore();
    const settings = await store.getSettings();
    const tokens = await store.getTokens();
    return NextResponse.json({
      settings,
      accurate: {
        configured: accurateConfigured(),
        missing: missingAccurateEnv(),
        connected: Boolean(tokens?.accessToken),
        userEmail: tokens?.userEmail ?? null,
        expiresAt: tokens?.expiresAt ?? null,
        redirectUri: accurateEnv().redirectUri,
        databaseIdFromEnv: Boolean(accurateEnv().databaseId),
        salesPush: salesPushEnabled(),
      },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requirePermission("settings.manage");
    const body = (await request.json()) as AppSettings;
    const settings = await (await getStore()).saveSettings(body);
    await recordAudit({ actorEmail: session.email, action: "settings.save", entity: "settings", entityId: "1", before: null, after: { locations: settings.jubelioLocations.length } });
    return NextResponse.json(settings);
  } catch (error) {
    return fail(error);
  }
}
