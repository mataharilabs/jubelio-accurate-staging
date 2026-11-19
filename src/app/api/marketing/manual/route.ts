import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { fail } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { actorLabel, requireMarketing } from "@/lib/marketing/access";
import { marketingStoreChoices } from "@/lib/marketing/catalog";
import { parseNumber } from "@/lib/marketing/parse";
import { ConflictError, addManual } from "@/lib/marketing/service";

function optional(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = parseNumber(value);
  return parsed == null ? null : Math.round(parsed);
}

function money(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = parseNumber(value);
  return parsed == null ? null : Math.round(parsed * 100) / 100;
}

export async function POST(request: Request) {
  try {
    const session = await requireMarketing(true);
    const body = (await request.json()) as Record<string, unknown>;
    const spend = money(body.spend);
    if (spend == null) throw new AppError("Isi spend.");
    const result = await addManual({
      periodStart: String(body.periodStart ?? ""),
      periodEnd: String(body.periodEnd ?? ""),
      platform: String(body.platform ?? ""),
      storeName: String(body.storeName ?? ""),
      campaign: String(body.campaign ?? ""),
      spend,
      impressions: optional(body.impressions),
      clicks: optional(body.clicks),
      orders: optional(body.orders),
      adsRevenue: money(body.adsRevenue),
      stores: await marketingStoreChoices(),
      overwrite: body.overwrite === true,
      actor: await actorLabel(session),
    });
    await recordAudit({
      actorEmail: session.email,
      action: body.overwrite === true ? "marketing.overwrite" : "marketing.manual",
      entity: "marketing_spend",
      entityId: null,
      before: null,
      after: { platform: body.platform, storeName: body.storeName, spend, ...result },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ConflictError) return NextResponse.json({ error: error.message, duplicates: error.duplicates }, { status: 409 });
    return fail(error);
  }
}
