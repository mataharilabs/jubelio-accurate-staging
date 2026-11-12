import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { contentDisposition } from "@/lib/export/files";
import { fail, requirePermission } from "@/lib/http";
import { listProducts } from "@/lib/products/service";

export async function GET(request: Request) {
  try {
    await requirePermission("products.view");
    const url = new URL(request.url);
    const picked = (url.searchParams.get("skus") ?? "").split(",").map((sku) => sku.trim()).filter(Boolean);
    const rows = (await listProducts({
      q: url.searchParams.get("q") ?? "",
      categoryId: url.searchParams.get("category") || undefined,
      brandId: url.searchParams.get("brand") || undefined,
      ordered: url.searchParams.get("ordered") === "yes" || url.searchParams.get("ordered") === "no" ? url.searchParams.get("ordered") as "yes" | "no" : undefined,
      noHpp: url.searchParams.get("noHpp") === "1",
      notInAccurate: url.searchParams.get("notInAccurate") === "1",
      incomplete: url.searchParams.get("incomplete") === "1",
      active: url.searchParams.get("dataStatus") === "deleted" || url.searchParams.get("dataStatus") === "all" ? url.searchParams.get("dataStatus") as "deleted" | "all" : "active",
      month: url.searchParams.get("month") || undefined,
    })).filter((row) => !picked.length || picked.includes(row.sku));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map((row) => ({
      SKU: row.sku, Nama: row.name, Kategori: row.categoryName ?? "", Merek: row.brandName ?? "", HPP: row.hpp ?? "", Sumber: row.hppSource ?? "",
    }))), "Produk");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": contentDisposition("produk-mapping.xlsx") } });
  } catch (error) {
    return fail(error);
  }
}
