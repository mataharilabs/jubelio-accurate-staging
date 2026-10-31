import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as { noPesanan?: string; lineId?: string };
    if (!body.noPesanan || !body.lineId) throw new AppError("Pesanan dan baris wajib diisi.");
    await (await getStore()).deleteLine(body.noPesanan, body.lineId, session.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
