import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requirePermission("orders.edit");
    const body = (await request.json()) as {
      noPesanan?: string;
      status?: string;
      returnCase?: 1 | 2 | 3 | null;
      lost?: { sku: string; qty: number }[];
    };
    if (!body.noPesanan || !body.status) throw new AppError("Pesanan dan status wajib diisi.");
    await (await getStore()).applyReturn(body.noPesanan, {
      status: body.status,
      returnCase: body.returnCase ?? null,
      lost: body.lost ?? [],
    }, session.email);
    await recordAudit({
      actorEmail: session.email,
      action: "order.return",
      entity: "order",
      entityId: body.noPesanan,
      before: null,
      after: { status: body.status, returnCase: body.returnCase ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
