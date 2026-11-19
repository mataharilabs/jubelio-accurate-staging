import { NextResponse } from "next/server";
import { formatPeriod } from "@/lib/marketing/dates";
import { metricsOf, sumMetrics } from "@/lib/marketing/metrics";
import { requireMarketing } from "@/lib/marketing/access";
import { marketingStoreChoices } from "@/lib/marketing/catalog";
import { duplicateText, prepareUpload } from "@/lib/marketing/service";
import { readMarketingFile } from "@/lib/marketing/upload";
import { fail } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await requireMarketing(true);
    const upload = await readMarketingFile(request);
    if (!upload.platform) return NextResponse.json({ error: "Pilih platform iklan." }, { status: 400 });
    const prepared = await prepareUpload({ ...upload, stores: await marketingStoreChoices() });
    const visible = prepared.rows.length ? prepared.rows : prepared.parsed.rows;
    return NextResponse.json({
      filename: upload.filename,
      source: prepared.source,
      platform: prepared.parsed.platform,
      kind: prepared.parsed.kind,
      splitDaily: prepared.parsed.splitDaily,
      storeRaw: prepared.parsed.storeRaw,
      storeMatch: prepared.storeMatch,
      storeAmbiguous: prepared.storeAmbiguous,
      needsStore: prepared.parsed.kind !== "template" && prepared.unresolved.length > 0 && !prepared.parsed.crossesMonth,
      unresolved: prepared.unresolved,
      periodStart: prepared.parsed.periodStart,
      periodEnd: prepared.parsed.periodEnd,
      periodLabel: prepared.parsed.periodStart && prepared.parsed.periodEnd ? formatPeriod(prepared.parsed.periodStart, prepared.parsed.periodEnd) : "—",
      readCount: prepared.parsed.readCount,
      validCount: prepared.rows.length,
      skipped: prepared.parsed.skipped,
      crossesMonth: prepared.parsed.crossesMonth,
      monthMessage: prepared.parsed.monthMessage,
      note: prepared.parsed.note,
      duplicates: prepared.duplicates,
      duplicateMessage: duplicateText(prepared.duplicates),
      totals: sumMetrics(visible),
      rows: visible.slice(0, 200).map((row) => ({
        lineNo: row.lineNo,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        periodLabel: formatPeriod(row.periodStart, row.periodEnd),
        platform: row.platform,
        storeName: "storeName" in row ? row.storeName : prepared.storeMatch,
        campaign: row.campaign,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        orders: row.orders,
        adsRevenue: row.adsRevenue,
        metrics: metricsOf(row),
      })),
    });
  } catch (error) {
    return fail(error);
  }
}
