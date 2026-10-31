import { NextResponse } from "next/server";
import { dashboardQuery } from "@/lib/api/query";
import { getStore } from "@/lib/db";
import type { DashboardQuery, OrderPageRow } from "@/lib/db/types";
import {
  contentDisposition,
  dashboardSheet,
  historySheet,
  ordersSheet,
  pdfDashboard,
  pdfHistory,
  pdfOrders,
  pdfSync,
  syncSheet,
} from "@/lib/export/files";
import { fail, requireSession } from "@/lib/http";

async function allOrderRows(store: Awaited<ReturnType<typeof getStore>>, day: string | null, q: string): Promise<OrderPageRow[]> {
  const rows: OrderPageRow[] = [];
  let page = 0;
  for (;;) {
    const result = await store.listOrders({ day, q, page, pageSize: 500 });
    rows.push(...result.rows);
    if (page >= result.pages - 1) break;
    page += 1;
  }
  return rows;
}

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = (await request.json()) as {
      target: "dashboard" | "orders" | "sync" | "history";
      format: "xlsx" | "pdf";
      query?: Partial<DashboardQuery>;
      periods?: { label: string; from: string; to: string }[];
      day?: string | null;
      q?: string;
      days?: string[];
    };
    const store = await getStore();
    const format = body.format === "pdf" ? "pdf" : "xlsx";
    let buffer: Buffer;
    let filename = "ekspor";
    if (body.target === "orders") {
      const rows = await allOrderRows(store, body.day || null, body.q ?? "");
      buffer = format === "pdf" ? await pdfOrders(rows) : ordersSheet(rows);
      filename = "data-pesanan";
    } else if (body.target === "sync") {
      const rows = await store.syncReview(body.days ?? []);
      buffer = format === "pdf" ? await pdfSync(rows) : syncSheet(rows);
      filename = "sync-review";
    } else if (body.target === "history") {
      const history = await store.syncHistory();
      buffer = format === "pdf" ? await pdfHistory(history.batches) : historySheet(history.batches, history.items);
      filename = "riwayat-sync";
    } else {
      const base = dashboardQuery(body.query);
      const report = await store.dashboard(base);
      const compare = body.periods?.length
        ? await Promise.all(body.periods.map(async (period) => ({
          label: period.label,
          report: await store.dashboard(dashboardQuery(base, period.from, period.to)),
        })))
        : undefined;
      const subtitle = `${base.from ?? "awal"} s/d ${base.to ?? "akhir"}`;
      buffer = format === "pdf" ? await pdfDashboard(report, subtitle) : dashboardSheet(report, compare);
      filename = "dashboard";
    }
    const type = format === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": type,
        "Content-Disposition": contentDisposition(`${filename}.${format}`),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
