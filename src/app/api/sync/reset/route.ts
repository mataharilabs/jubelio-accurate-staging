import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = (await request.json()) as { batchId?: string; noPesanan?: string };
    if (!body.batchId || !body.noPesanan) throw new AppError("Batch dan nomor pesanan wajib diisi.");
    await (await getStore()).resetOrder(body.batchId, body.noPesanan);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
