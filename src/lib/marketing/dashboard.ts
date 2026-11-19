import type { DashboardQuery, DashboardReport } from "@/lib/db/types";
import { applyMarketingAllocation } from "@/lib/marketing/allocate";
import { listActiveSlices } from "@/lib/marketing/service";

export async function attachMarketing(report: DashboardReport, query: DashboardQuery): Promise<DashboardReport> {
  const slices = await listActiveSlices();
  return applyMarketingAllocation(report, slices, query);
}
