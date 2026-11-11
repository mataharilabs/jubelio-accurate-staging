import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { AppError } from "@/lib/errors";
import { fail, requireMaster } from "@/lib/http";
import { listCatalog, saveCatalog } from "@/lib/products/service";

function kindOf(value: string): "categories" | "brands" {
  if (value === "categories" || value === "kategori") return "categories";
  if (value === "brands" || value === "merek") return "brands";
  throw new AppError("Master tidak dikenal.");
}

export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requireMaster("products.view");
    const { kind } = await context.params;
    return NextResponse.json(await listCatalog(kindOf(kind)));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    const session = await requireMaster("products.manage");
    const { kind } = await context.params;
    const body = await request.json() as { id?: string; name?: string; active?: boolean; replacementId?: string | null; code?: string; note?: string };
    const savedKind = kindOf(kind);
    await saveCatalog(savedKind, { id: body.id, name: body.name ?? "", active: body.active, replacementId: body.replacementId, code: body.code, note: body.note }, session.email);
    await recordAudit({
      actorEmail: session.email,
      action: body.active === false ? "catalog.delete" : body.id ? "catalog.update" : "catalog.create",
      entity: savedKind,
      entityId: body.id ?? body.name ?? "",
      before: null,
      after: { name: body.name ?? "", active: body.active ?? true, code: body.code ?? "", note: body.note ?? "" },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
