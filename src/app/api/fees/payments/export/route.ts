import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { contentDisposition } from "@/lib/export/files";
import { requireFees } from "@/lib/fees/access";
import { listPayments } from "@/lib/fees/service";
import { fail } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await requireFees(false);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const rows = [];
    let page = 0;
    for (;;) {
      const result = await listPayments({ q, page, pageSize: 1000 });
      rows.push(...result.rows);
      if (!result.rows.length || page >= result.pages - 1) break;
      page += 1;
    }
    const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
      "No pesanan": row.noPesanan,
      Channel: row.channel,
      Toko: row.storeName,
      "Revenue bersih": row.net,
      Nominal: row.amountRp,
      Selisih: row.diff,
      Tanggal: row.paidAt,
      Metode: row.method,
      Catatan: row.note,
      Oleh: row.createdBy,
    })));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Pembayaran");
    const body = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": contentDisposition("pembayaran-dicatat.xlsx"),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
