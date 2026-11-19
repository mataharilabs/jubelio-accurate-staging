export type MetricInputs = {
  spend: number;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  adsRevenue: number | null;
};

export type Metrics = {
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cvr: number | null;
  cpo: number | null;
  roas: number | null;
  acos: number | null;
};

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

/** Ratios from one row or from already-summed totals. Never average ratios. */
export function metricsOf(row: MetricInputs): Metrics {
  return {
    ctr: ratio(row.clicks, row.impressions),
    cpc: ratio(row.spend, row.clicks),
    cpm: row.impressions ? (row.spend / row.impressions) * 1000 : null,
    cvr: ratio(row.orders, row.clicks),
    cpo: ratio(row.spend, row.orders),
    roas: ratio(row.adsRevenue, row.spend === 0 ? null : row.spend),
    acos: ratio(row.spend, row.adsRevenue),
  };
}

export function sumMetrics(rows: MetricInputs[]): MetricInputs {
  const sum = (pick: (row: MetricInputs) => number | null) => {
    let total = 0;
    let any = false;
    for (const row of rows) {
      const value = pick(row);
      if (value == null) continue;
      any = true;
      total += value;
    }
    return any ? total : null;
  };
  return {
    spend: rows.reduce((total, row) => total + (Number.isFinite(row.spend) ? row.spend : 0), 0),
    impressions: sum((row) => row.impressions),
    clicks: sum((row) => row.clicks),
    orders: sum((row) => row.orders),
    adsRevenue: sum((row) => row.adsRevenue),
  };
}

export function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export function formatRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("id-ID");
}
