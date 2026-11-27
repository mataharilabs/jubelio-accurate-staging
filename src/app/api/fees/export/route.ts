import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/export/files";
import { requireFees } from "@/lib/fees/access";
import { feeSheet, pdfFees } from "@/lib/fees/export-file";
import { feeReport, type FeeReportKind } from "@/lib/fees/service";
import { fail } from "@/lib/http";

function kindOf(value: string | null): FeeReportKind {
  if (value === "affiliate" || value === "sku" || value === "group") return value;
  return "group";
}

const TITLE: Record<FeeReportKind, string> = {
  affiliate: "Komisi afiliasi per pesanan",
  group: "Biaya per grup",
  sku: "Biaya per SKU",
};

export async function GET(request: Request) {
  try {
    await requireFees(false);
    const url = new URL(request.url);
    const kind = kindOf(url.searchParams.get("kind"));
    const format = url.searchParams.get("format") === "pdf" ? "pdf" : "xlsx";
    const query = {
      kind,
      from: url.searchParams.get("from") || null,
      to: url.searchParams.get("to") || null,
      channels: (url.searchParams.get("channels") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      stores: (url.searchParams.get("stores") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    };
    const rows = [];
    let page = 0;
    for (;;) {
      const result = await feeReport({ ...query, page, pageSize: 1000 });
      rows.push(...result.rows);
      if (!result.rows.length || page >= result.pages - 1) break;
      page += 1;
    }
    if (format === "pdf" && rows.length > 200) {
      return NextResponse.json({ error: "PDF terlalu besar untuk filter ini. Unduh Excel agar semua baris ikut." }, { status: 400 });
    }
    const body = format === "pdf" ? await pdfFees(TITLE[kind], rows) : feeSheet(kind, rows);
    const filename = `biaya-${kind}.${format === "pdf" ? "pdf" : "xlsx"}`;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": contentDisposition(filename),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
