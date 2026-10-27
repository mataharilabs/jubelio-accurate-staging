import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getStore } from "@/lib/db";
import type { SalesLine } from "@/lib/db/types";
import { fail, requireSession } from "@/lib/http";

function sheet(lines: SalesLine[]) {
  const data = lines.map((line) => ({
    "No Pesanan": line.noPesanan,
    Channel: line.channel,
    SKU: line.sku,
    Qty: line.qty,
    "Unit Price": line.hargaJual,
    "Total Diskon": line.totalDiskon,
  }));
  const context = lines.map((line) => ({
    "No Pesanan": line.noPesanan,
    "No Pesanan Asal": line.noPesananSumber,
    Tanggal: line.tanggal,
    "Lokasi Gudang": line.lokasiGudang,
    "Nama Toko": line.namaToko,
    Status: line.status,
    "Nama Barang": line.namaBarang,
    "SKU Asal": line.sourceSku,
    "Kunci Bundle": line.bundleKey,
    Bobot: line.bobot,
    "Bobot Hilang": line.missingWeight ? "ya" : "",
    "Status Sinkron": line.syncStatus,
  }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(data), "Data");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(context), "Konteks");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
    const { id } = await context.params;
    const bundle = await (await getStore()).getBatchBundle(id);
    if (!bundle) return NextResponse.json({ error: "Batch tidak ditemukan." }, { status: 404 });
    const body = sheet(bundle.lines);
    const filename = `Rapi_${bundle.batch.reportDate}.xlsx`;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return fail(error);
  }
}
