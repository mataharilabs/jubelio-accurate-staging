import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { actorLabel, requireFees } from "@/lib/fees/access";
import { applyFeeChunk } from "@/lib/fees/service";
import type { FeeDraft, Marketplace } from "@/lib/fees/types";
import { MARKETPLACES } from "@/lib/fees/types";
import { fail } from "@/lib/http";

function isMarketplace(value: string): value is Marketplace {
  return (MARKETPLACES as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  try {
    const session = await requireFees(true);
    const body = await request.json() as {
      importId?: string;
      marketplace?: string;
      format?: string;
      fileName?: string;
      allocate?: boolean;
      matchedOrders?: number;
      unmatchedOrders?: number;
      rows?: FeeDraft[];
    };
    const marketplace = String(body.marketplace ?? "");
    if (!isMarketplace(marketplace)) return NextResponse.json({ error: "Marketplace tidak dikenal." }, { status: 400 });
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ error: "Tidak ada baris biaya untuk disimpan." }, { status: 400 });
    if (rows.length > 1000) return NextResponse.json({ error: "Kirim biaya dalam kelompok yang lebih kecil." }, { status: 413 });
    const result = await applyFeeChunk({
      importId: String(body.importId || crypto.randomUUID()),
      marketplace,
      format: String(body.format ?? ""),
      fileName: String(body.fileName ?? ""),
      actor: await actorLabel(session),
      allocate: Boolean(body.allocate),
      matchedOrders: Number(body.matchedOrders ?? 0),
      unmatchedOrders: Number(body.unmatchedOrders ?? 0),
      rows,
    });
    await recordAudit({
      actorEmail: session.email,
      action: "fees.import",
      entity: "fee_imports",
      entityId: result.importId,
      before: null,
      after: { fileName: body.fileName ?? "", marketplace, inserted: result.inserted, replaced: result.replaced, skipped: result.skipped },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return fail(error);
  }
}
