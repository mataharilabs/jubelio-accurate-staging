import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { fail, requirePermission } from "@/lib/http";
import { listProducts, productIncomplete, saveManualCost, saveProduct } from "@/lib/products/service";

export async function GET(request: Request) {
  try {
    await requirePermission("products.view");
    const url = new URL(request.url);
    const rows = await listProducts({
      q: url.searchParams.get("q") ?? "",
      categoryId: url.searchParams.get("category") || undefined,
      brandId: url.searchParams.get("brand") || undefined,
      noHpp: url.searchParams.get("noHpp") === "1",
      notInAccurate: url.searchParams.get("notInAccurate") === "1",
      incomplete: url.searchParams.get("incomplete") === "1",
    });
    return NextResponse.json({ rows, incomplete: rows.filter(productIncomplete).length });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePermission("products.manage");
    const body = await request.json() as { sku?: string; name?: string; categoryId?: string | null; brandId?: string | null; active?: boolean; unitCost?: number; note?: string; skus?: string[] };
    if (body.skus?.length) {
      const current = await listProducts();
      for (const sku of body.skus) {
        const existing = current.find((row) => row.sku === sku);
        await saveProduct({ sku, name: existing?.name ?? sku, categoryId: body.categoryId === undefined ? existing?.categoryId : body.categoryId, brandId: body.brandId === undefined ? existing?.brandId : body.brandId, active: existing?.active ?? true }, session.email);
      }
      return NextResponse.json({ ok: true, count: body.skus.length });
    }
    if (!body.sku?.trim()) return NextResponse.json({ error: "SKU wajib diisi." }, { status: 400 });
    await saveProduct({ sku: body.sku, name: body.name ?? "", categoryId: body.categoryId, brandId: body.brandId, active: body.active }, session.email);
    if (body.unitCost != null) await saveManualCost(body.sku.trim(), Number(body.unitCost), body.note ?? "", session.email);
    await recordAudit({ actorEmail: session.email, action: "product.save", entity: "product", entityId: body.sku.trim(), before: null, after: { name: body.name, categoryId: body.categoryId, brandId: body.brandId, unitCost: body.unitCost ?? null } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
