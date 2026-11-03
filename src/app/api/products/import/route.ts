import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { fail, requirePermission } from "@/lib/http";
import { listCatalog, saveManualCost, saveProduct } from "@/lib/products/service";

export async function POST(request: Request) {
  try {
    const session = await requirePermission("products.manage");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Pilih berkas Excel." }, { status: 400 });
    const book = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[book.SheetNames[0]], { defval: "" });
    const categories = await listCatalog("categories");
    const brands = await listCatalog("brands");
    let count = 0;
    for (const row of rows) {
      const sku = String(row.SKU ?? row.sku ?? "").trim();
      if (!sku) continue;
      const categoryName = String(row.Kategori ?? row.kategori ?? "").trim();
      const brandName = String(row.Merek ?? row.merek ?? "").trim();
      const category = categories.find((item) => item.name.toLowerCase() === categoryName.toLowerCase());
      const brand = brands.find((item) => item.name.toLowerCase() === brandName.toLowerCase());
      await saveProduct({
        sku,
        name: String(row.Nama ?? row.nama ?? ""),
        categoryId: category?.id ?? null,
        brandId: brand?.id ?? null,
      }, session.email);
      const hpp = Number(row.HPP ?? row.hpp ?? "");
      if (Number.isFinite(hpp) && String(row.HPP ?? row.hpp ?? "") !== "") await saveManualCost(sku, hpp, "Impor Excel", session.email);
      count += 1;
    }
    return NextResponse.json({ ok: true, count });
  } catch (error) {
    return fail(error);
  }
}
