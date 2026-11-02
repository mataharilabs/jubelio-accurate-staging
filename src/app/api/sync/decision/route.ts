import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { recordAudit } from "@/lib/access/store";
import { fail, requirePermission } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requirePermission("sync.confirm");
    const body = (await request.json()) as { noPesanan?: string; decision?: "confirmed" | "ignored" };
    if (!body.noPesanan || (body.decision !== "confirmed" && body.decision !== "ignored")) {
      throw new AppError("Keputusan tidak valid.");
    }
    await recordAudit({ actorEmail: session.email, action: "sync.decision", entity: "order", entityId: body.noPesanan, before: null, after: { decision: body.decision } });
    await (await getStore()).setDecision(body.noPesanan, body.decision, session.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
