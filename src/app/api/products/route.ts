import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { AppError } from "@/lib/errors";
import { fail, requireMaster, requirePermission } from "@/lib/http";
import { monthStart } from "@/lib/products/cost";
import { listProducts, productIncomplete, saveManualCost, saveProduct, wibMonth } from "@/lib/products/service";

export async function GET(request: Request) {
  try {
    await requirePermission("products.view");
    const url = new URL(request.url);
    const month = monthStart(url.searchParams.get("month") || wibMonth());
    const rows = await listProducts({
      q: url.searchParams.get("q") ?? "",
      categoryId: url.searchParams.get("category") || undefined,
      brandId: url.searchParams.get("brand") || undefined,
      noHpp: url.searchParams.get("noHpp") === "1",
      notInAccurate: url.searchParams.get("notInAccurate") === "1",
      incomplete: url.searchParams.get("incomplete") === "1",
      confirmed: url.searchParams.get("confirmed") === "yes" || url.searchParams.get("confirmed") === "no" ? url.searchParams.get("confirmed") as "yes" | "no" : undefined,
      ordered: url.searchParams.get("ordered") === "yes" || url.searchParams.get("ordered") === "no" ? url.searchParams.get("ordered") as "yes" | "no" : undefined,
      active: url.searchParams.get("dataStatus") === "deleted" || url.searchParams.get("dataStatus") === "all" ? url.searchParams.get("dataStatus") as "deleted" | "all" : "active",
      month,
    });
    return NextResponse.json({ rows, incomplete: rows.filter(productIncomplete).length, month });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireMaster("products.manage");
    const body = await request.json() as { sku?: string; name?: string; categoryId?: string | null; brandId?: string | null; active?: boolean; unitCost?: number; note?: string; skus?: string[]; periodMonth?: string; hppOnly?: boolean };
    if (body.hppOnly) {
      const sku = body.sku?.trim() ?? "";
      if (!sku) throw new AppError("SKU wajib diisi.");
      if (body.unitCost == null || !Number.isFinite(Number(body.unitCost))) throw new AppError("Nilai DPP wajib diisi.");
      const existing = (await listProducts({ active: "active" })).find((row) => row.sku === sku && row.active !== false);
      if (!existing) throw new AppError(`SKU ${sku} tidak ada di Master Produk.`);
      const periodMonth = monthStart(body.periodMonth || wibMonth());
      await saveManualCost(sku, Number(body.unitCost), body.note ?? "HPP manual", session.email, periodMonth);
      await recordAudit({ actorEmail: session.email, action: "hpp.manual", entity: "product_cost", entityId: sku, before: null, after: { sku, unitCost: Number(body.unitCost), periodMonth, source: "manual" } });
      return NextResponse.json({ ok: true });
    }
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
    if (body.unitCost != null) await saveManualCost(body.sku.trim(), Number(body.unitCost), body.note ?? "", session.email, monthStart(body.periodMonth || wibMonth()));
    await recordAudit({ actorEmail: session.email, action: "product.save", entity: "product", entityId: body.sku.trim(), before: null, after: { name: body.name, categoryId: body.categoryId, brandId: body.brandId, unitCost: body.unitCost ?? null } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
