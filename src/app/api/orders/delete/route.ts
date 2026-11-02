import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { recordAudit } from "@/lib/access/store";
import { fail, requirePermission } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requirePermission("orders.edit");
    const body = (await request.json()) as { noPesanan?: string; lineId?: string };
    if (!body.noPesanan || !body.lineId) throw new AppError("Pesanan dan baris wajib diisi.");
    await recordAudit({ actorEmail: session.email, action: "order.delete", entity: "order", entityId: body.noPesanan, before: null, after: { lineId: body.lineId } });
    await (await getStore()).deleteLine(body.noPesanan, body.lineId, session.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
