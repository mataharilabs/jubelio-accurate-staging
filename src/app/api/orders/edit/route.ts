import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as { noPesanan?: string; lineId?: string; sku?: string; qty?: number; unitPrice?: number; city?: string };
    if (!body.noPesanan || !body.lineId) throw new AppError("Pesanan dan baris wajib diisi.");
    await (await getStore()).editLine(body.noPesanan, body.lineId, {
      sku: body.sku,
      qty: body.qty,
      unitPrice: body.unitPrice,
      city: body.city,
    }, session.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
