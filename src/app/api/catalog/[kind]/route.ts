import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";
import { listCatalog, saveCatalog } from "@/lib/products/service";

function kindOf(value: string): "categories" | "brands" {
  if (value === "categories" || value === "kategori") return "categories";
  if (value === "brands" || value === "merek") return "brands";
  throw new AppError("Master tidak dikenal.");
}

export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requirePermission("products.view");
    const { kind } = await context.params;
    return NextResponse.json(await listCatalog(kindOf(kind)));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    const session = await requirePermission("products.manage");
    const { kind } = await context.params;
    const body = await request.json() as { id?: string; name?: string; active?: boolean };
    await saveCatalog(kindOf(kind), { id: body.id, name: body.name ?? "", active: body.active }, session.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
