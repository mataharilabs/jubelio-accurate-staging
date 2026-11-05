import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requirePermission("orders.edit");
    const body = (await request.json()) as { noPesanan?: string; dataStatus?: "active" | "deleted" };
    if (!body.noPesanan || (body.dataStatus !== "active" && body.dataStatus !== "deleted")) {
      throw new AppError("Pesanan dan status data wajib diisi.");
    }
    await (await getStore()).setDataStatus(body.noPesanan, body.dataStatus);
    await recordAudit({
      actorEmail: session.email,
      action: body.dataStatus === "deleted" ? "order.soft_delete" : "order.restore",
      entity: "order",
      entityId: body.noPesanan,
      before: null,
      after: { dataStatus: body.dataStatus },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
