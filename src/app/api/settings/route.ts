import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import type { AppSettings } from "@/lib/db/types";
import { accurateConfigured, accurateEnv, missingAccurateEnv } from "@/lib/env";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
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
      },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: Request) {
  try {
    await requireSession();
    const body = (await request.json()) as AppSettings;
    const settings = await (await getStore()).saveSettings(body);
    return NextResponse.json(settings);
  } catch (error) {
    return fail(error);
  }
}
