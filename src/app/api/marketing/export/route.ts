import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/export/files";
import { fail } from "@/lib/http";
import { requireMarketing } from "@/lib/marketing/access";
import { formatPeriod, wibMonth } from "@/lib/marketing/dates";
import { formatPct, formatRatio, metricsOf } from "@/lib/marketing/metrics";
import { filterMarketingRows } from "@/lib/marketing/query";
import { listMarketing } from "@/lib/marketing/service";
import { exportCsv, exportWorkbook } from "@/lib/marketing/template";

export async function GET(request: Request) {
  try {
    await requireMarketing(false);
    const url = new URL(request.url);
    const month = url.searchParams.get("month") || wibMonth();
    const status = url.searchParams.get("status") === "deleted" || url.searchParams.get("status") === "all" ? url.searchParams.get("status") as "deleted" | "all" : "active";
    const rows = filterMarketingRows(await listMarketing({ month, status }), {
      store: url.searchParams.get("store") ?? "",
      platform: url.searchParams.get("platform") ?? "",
      source: url.searchParams.get("source") ?? "",
      q: url.searchParams.get("q") ?? "",
    });
    const table = rows.map((row) => {
      const metrics = metricsOf(row);
      return {
        Periode: formatPeriod(row.periodStart, row.periodEnd),
        Platform: row.platform,
        Toko: row.storeName,
        Kampanye: row.campaign,
        Spend: row.spend,
        Impresi: row.impressions,
        Klik: row.clicks,
        "Pesanan iklan": row.orders,
        "Omzet iklan": row.adsRevenue,
        CTR: formatPct(metrics.ctr),
        CPC: metrics.cpc == null ? null : Math.round(metrics.cpc),
        CPM: metrics.cpm == null ? null : Math.round(metrics.cpm),
        CVR: formatPct(metrics.cvr),
        CPO: metrics.cpo == null ? null : Math.round(metrics.cpo),
        ROAS: formatRatio(metrics.roas),
        ACOS: formatPct(metrics.acos),
        Sumber: row.source,
        File: row.sourceFile,
        Diinput: row.createdBy,
        "Waktu input": row.createdAt,
        Status: row.deletedAt ? "Dihapus" : "Aktif",
      };
    });
    const format = url.searchParams.get("format") === "csv" ? "csv" : "xlsx";
    if (format === "csv") {
      return new NextResponse(exportCsv(table), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`marketing-spending-${month}.csv`) },
      });
    }
    const buffer = exportWorkbook(table);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": contentDisposition(`marketing-spending-${month}.xlsx`),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
