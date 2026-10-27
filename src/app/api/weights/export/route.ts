import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    const weights = await (await getStore()).listWeights();
    const rows: (string | number)[][] = [
      ["", "SKU BUNDLE", "BOBOT PER ITEM"],
      ...weights.map((row) => ["", row.bundleKey, row.bobot]),
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Tabel Bundle");
    const body = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="bobot-bundle.xlsx"',
      },
    });
  } catch (error) {
    return fail(error);
  }
}
