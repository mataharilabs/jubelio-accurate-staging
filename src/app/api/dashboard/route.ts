import { NextResponse } from "next/server";
import { dashboardQuery } from "@/lib/api/query";
import { getStore } from "@/lib/db";
import type { DashboardQuery } from "@/lib/db/types";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = (await request.json()) as {
      query?: Partial<DashboardQuery>;
      periods?: { label: string; from: string; to: string }[];
      includeOptions?: boolean;
    };
    const store = await getStore();
    const base = dashboardQuery(body.query);
    const periods = body.periods?.length ? body.periods : [{ label: "Periode", from: base.from ?? "", to: base.to ?? "" }];
    const reports = await Promise.all(periods.map(async (period) => ({
      label: period.label,
      from: period.from,
      to: period.to,
      report: await store.dashboard(dashboardQuery(base, period.from || null, period.to || null)),
    })));
    const options = body.includeOptions ? await store.filterOptions() : undefined;
    return NextResponse.json({ reports, options });
  } catch (error) {
    return fail(error);
  }
}
