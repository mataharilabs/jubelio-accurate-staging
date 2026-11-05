"use client";

import { CommerceDashboard } from "@/components/commerce-dashboard";

export function DashboardView({ mode = "toko" }: { mode?: "toko" | "produk" }) {
  return <CommerceDashboard mode={mode} />;
}
