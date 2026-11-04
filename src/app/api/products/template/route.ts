import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { contentDisposition } from "@/lib/export/files";
import { fail, requirePermission } from "@/lib/http";
import { listProducts } from "@/lib/products/service";

export async function GET() {
  try {
    await requirePermission("products.view");
    const rows = await listProducts();
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
