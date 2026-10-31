import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as { noPesanan?: string; decision?: "confirmed" | "ignored" };
    if (!body.noPesanan || (body.decision !== "confirmed" && body.decision !== "ignored")) {
      throw new AppError("Keputusan tidak valid.");
    }
    await (await getStore()).setDecision(body.noPesanan, body.decision, session.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
