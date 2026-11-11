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
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";
import type { Permission } from "@/lib/auth/permissions";

async function allOrderRows(store: Awaited<ReturnType<typeof getStore>>, query: { day: string | null; from?: string | null; to?: string | null; statuses?: string[]; q: string; dataStatus?: "active" | "deleted" | "all"; channels?: string[]; stores?: string[]; sync?: "" | "need" | "done" }): Promise<OrderPageRow[]> {
  const rows: OrderPageRow[] = [];
  let page = 0;
  for (;;) {
    const result = await store.listOrders({ ...query, page, pageSize: 1000 });
    rows.push(...result.rows);
    if (!result.rows.length || page >= result.pages - 1) break;
    page += 1;
  }
  return rows;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      target: "dashboard" | "orders" | "sync" | "history";
      format: "xlsx" | "pdf";
      query?: Partial<DashboardQuery>;
      periods?: { label: string; from: string; to: string }[];
      day?: string | null;
      from?: string | null;
      to?: string | null;
      statuses?: string[];
      q?: string;
      dataStatus?: "active" | "deleted" | "all";
      channels?: string[];
      stores?: string[];
      sync?: "" | "need" | "done";
      nos?: string[];
      allowLargePdf?: boolean;
      days?: string[];
      metric?: "net" | "gross";
    };
    const permission: Permission = body.target === "orders" ? "orders.export" : body.target === "dashboard" ? "dashboard.export" : "sync.view";
    await requirePermission(permission);
    const store = await getStore();
    const format = body.format === "pdf" ? "pdf" : "xlsx";
    let buffer: Buffer;
    let filename = "ekspor";
    if (body.target === "orders") {
      let rows = await allOrderRows(store, {
        day: body.day || null,
        from: body.from,
        to: body.to,
        statuses: body.statuses,
        q: body.q ?? "",
        dataStatus: body.dataStatus,
        channels: body.channels,
        stores: body.stores,
        sync: body.sync,
      });
      if (body.nos?.length) {
        const wanted = new Set(body.nos);
        rows = rows.filter((row) => wanted.has(row.noPesanan));
      }
      if (format === "pdf" && rows.length > 200 && !body.allowLargePdf) {
        throw new AppError("PDF terlalu besar untuk filter ini. Unduh Excel agar semua baris ikut.");
      }
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
      const subtitle = `${base.from ?? "awal"} s/d ${base.to ?? "akhir"} · ${body.metric === "gross" ? "Penjualan kotor" : "Revenue bersih"}`;
      buffer = format === "pdf" ? await pdfDashboard(report, subtitle, body.metric === "gross" ? "gross" : "net") : dashboardSheet(report, compare);
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
