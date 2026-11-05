import { NextResponse } from "next/server";
import { accurateApiConfigured, accurateApiEnv, openAccurateHost } from "@/lib/accurate/api-token";
import { listDatabases } from "@/lib/accurate/client";
import { getStore } from "@/lib/db";
import { fail, requirePermission } from "@/lib/http";

export async function POST() {
  try {
    await requirePermission("settings.manage");
    const started = Date.now();
    const tokens = await (await getStore()).getTokens();
    if (tokens?.accessToken) {
      const databases = await listDatabases(tokens.accessToken);
      return NextResponse.json({ ok: true, ms: Date.now() - started, databases: databases.length });
    }
    if (!accurateApiConfigured()) {
      return NextResponse.json({ ok: false, error: "Accurate belum terhubung." }, { status: 400 });
    }
    const env = accurateApiEnv();
    await openAccurateHost(fetch, env.token, env.signatureKey);
    return NextResponse.json({ ok: true, ms: Date.now() - started });
  } catch (error) {
    return fail(error);
  }
}
