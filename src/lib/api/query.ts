import type { DashboardQuery } from "@/lib/db/types";

export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function dashboardQuery(input: Partial<DashboardQuery> | null | undefined, from?: string | null, to?: string | null): DashboardQuery {
  const gran = input?.granularity;
  return {
    from: from ?? input?.from ?? null,
    to: to ?? input?.to ?? null,
    granularity: gran === "week" || gran === "month" ? gran : "day",
    channels: asList(input?.channels),
    stores: asList(input?.stores),
    provinces: asList(input?.provinces),
    cities: asList(input?.cities),
    statuses: asList(input?.statuses),
    couriers: asList(input?.couriers),
    skus: asList(input?.skus),
  };
}
