"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart, CHART_PAL, Donut, HBars } from "@/components/charts";
import { downloadExport } from "@/components/download";
import { api } from "@/lib/api-client";
import type { DashboardQuery, DashboardReport, FilterOptions, ProductRow } from "@/lib/db/types";
import { dayShort } from "@/lib/domain/aggregate";
import { numId, rp, rpCompact } from "@/lib/format";

type Period = { label: string; from: string; to: string };
type Sel = Record<string, string[]>;

const FILTERS: [keyof Sel, string][] = [
  ["channels", "Channel"],
  ["stores", "Toko"],
  ["provinces", "Provinsi"],
  ["cities", "Kota"],
  ["statuses", "Status"],
  ["couriers", "Kurir"],
  ["skus", "SKU"],
];

const EMPTY: Sel = { channels: [], stores: [], provinces: [], cities: [], statuses: [], couriers: [], skus: [] };

function pct(a: number, b: number) {
  if (!b) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function Pct({ a, b }: { a: number; b: number }) {
  const value = pct(a, b);
  if (value == null) return <span className="mut">—</span>;
  return <span className={value >= 0 ? "up" : "dn"}>{value >= 0 ? "▲" : "▼"} {Math.abs(value).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%</span>;
}

function daysBetween(from: string, to: string) {
  if (!from || !to) return 0;
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
}

export function DashboardView() {
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [granularity, setGranularity] = useState<DashboardQuery["granularity"]>("day");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sel, setSel] = useState<Sel>(EMPTY);
  const [more, setMore] = useState(true);
  const [compare, setCompare] = useState(false);
  const [periods, setPeriods] = useState<Period[]>([
    { label: "Periode A", from: "", to: "" },
    { label: "Periode B", from: "", to: "" },
  ]);
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [compared, setCompared] = useState<{ label: string; from: string; to: string; report: DashboardReport }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [best, setBest] = useState<"qty" | "net">("qty");
  const [geo, setGeo] = useState<"provinces" | "cities">("provinces");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: keyof ProductRow; dir: number }>({ key: "net", dir: -1 });
  const [openMs, setOpenMs] = useState<string | null>(null);

  const query = useMemo<DashboardQuery>(() => ({
    from: from || null,
    to: to || null,
    granularity,
    channels: sel.channels,
    stores: sel.stores,
    provinces: sel.provinces,
    cities: sel.cities,
    statuses: sel.statuses,
    couriers: sel.couriers,
    skus: sel.skus,
  }), [from, to, granularity, sel]);

  useEffect(() => {
    let stop = false;
    api<{ reports: { report: DashboardReport }[]; options: FilterOptions }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query: { granularity: "day" }, includeOptions: true }),
    }).then((result) => {
      if (stop) return;
      setOptions(result.options);
      const min = result.options.minDay ?? "";
      const max = result.options.maxDay ?? "";
      setFrom(min);
      setTo(max);
      const start = new Date(`${min}T00:00:00Z`);
      const end = new Date(`${max}T00:00:00Z`);
      const span = Math.round((end.getTime() - start.getTime()) / 86400000);
      const leftEnd = new Date(start);
      leftEnd.setUTCDate(leftEnd.getUTCDate() + Math.max(0, Math.floor(Math.max(span - 1, 0) / 2)));
      const rightStart = new Date(leftEnd);
      rightStart.setUTCDate(rightStart.getUTCDate() + 1);
      const iso = (date: Date) => date.toISOString().slice(0, 10);
      setPeriods([
        { label: "Periode A", from: min, to: iso(leftEnd) },
        { label: "Periode B", from: rightStart > end ? max : iso(rightStart), to: max },
      ]);
      setReady(true);
    }).catch((err: Error) => setError(err.message));
    return () => { stop = true; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const periodsBody = compare ? periods : [{ label: "Periode", from, to }];
    api<{ reports: { label: string; from: string; to: string; report: DashboardReport }[] }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query, periods: periodsBody }),
    }).then((result) => {
      setReport(result.reports[0]?.report ?? null);
      setCompared(result.reports);
      setError(null);
    }).catch((err: Error) => setError(err.message));
  }, [ready, query, compare, periods, from, to]);

  function toggle(key: string, value: string) {
    setSel((current) => {
      const list = current[key] ?? [];
      const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
      return { ...current, [key]: next };
    });
  }

  async function download(format: "xlsx" | "pdf") {
    await downloadExport(`dashboard.${format}`, {
      target: "dashboard",
      format,
      query,
      periods: compare ? periods : undefined,
    });
  }

  const optionMap: Record<string, string[]> = {
    channels: options?.channels ?? [],
    stores: options?.stores ?? [],
    provinces: options?.provinces ?? [],
    cities: options?.cities ?? [],
    statuses: options?.statuses ?? [],
    couriers: options?.couriers ?? [],
    skus: options?.skus ?? [],
  };
  const visibleFilters = more ? FILTERS : FILTERS.slice(0, 2);
  const products = (report?.products ?? []).filter((row) => !q || `${row.sku} ${row.name}`.toLowerCase().includes(q.toLowerCase()));
  products.sort((a, b) => ((a[sort.key] > b[sort.key] ? 1 : -1) * sort.dir));
  const bestRows = [...(report?.products ?? [])].sort((a, b) => best === "qty" ? b.qty - a.qty : b.net - a.net).slice(0, 10);
  const colors = Object.fromEntries((options?.channels ?? []).map((name, index) => [name, CHART_PAL[index % CHART_PAL.length]]));

  return (
    <div>
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="card">
        <button className="btn filter-toggle" onClick={() => setSheet(true)}>Filter</button>
        <div className={`sheet ${sheet ? "open" : ""}`}>
          {sheet ? <button className="btn" onClick={() => setSheet(false)}>Tutup filter</button> : null}
          <div className="filters" style={{ marginTop: sheet ? 12 : 0 }}>
            <div className="f">
              <label>Granularitas</label>
              <div className="seg">
                {([["day", "Harian"], ["week", "Mingguan"], ["month", "Bulanan"]] as const).map(([value, label]) => (
                  <button key={value} className={granularity === value ? "on" : ""} onClick={() => setGranularity(value)}>{label}</button>
                ))}
              </div>
            </div>
            {compare ? null : (
              <>
                <div className="f"><label>Dari</label><input type="date" value={from} min={options?.minDay ?? undefined} max={options?.maxDay ?? undefined} onChange={(event) => setFrom(event.target.value)} /></div>
                <div className="f"><label>Sampai</label><input type="date" value={to} min={options?.minDay ?? undefined} max={options?.maxDay ?? undefined} onChange={(event) => setTo(event.target.value)} /></div>
              </>
            )}
            {visibleFilters.map(([key, label]) => (
              <div className="f" key={key}>
                <label>{label}</label>
                <div className={`ms ${openMs === key ? "open" : ""}`}>
                  <button className="btn" onClick={() => setOpenMs(openMs === key ? null : key)}>
                    {sel[key]?.length ? `${sel[key].length} dipilih` : "Semua"} ▾
                  </button>
                  <div className="pop">
                    <label><input type="checkbox" checked={!sel[key]?.length} onChange={() => setSel((current) => ({ ...current, [key]: [] }))} /> Semua</label>
                    {(optionMap[key] ?? []).map((value) => (
                      <label key={value}><input type="checkbox" checked={sel[key]?.includes(value) ?? false} onChange={() => toggle(key, value)} /> {value}</label>
                    ))}
                  </div>
                </div>
              </div>
            ))}
            <div className="f"><label>&nbsp;</label><button className="btn ghost" onClick={() => setMore((value) => !value)}>{more ? "− Sembunyikan filter" : "+ Filter lainnya"}</button></div>
            <div className="f"><label>&nbsp;</label><button className={`btn ${compare ? "pri" : ""}`} onClick={() => setCompare((value) => !value)}>Bandingkan periode</button></div>
            <div className="f"><label>&nbsp;</label><button className="btn sm" onClick={() => download("xlsx")}>Excel</button></div>
            <div className="f"><label>&nbsp;</label><button className="btn sm" onClick={() => download("pdf")}>PDF</button></div>
          </div>
          {compare ? (
            <div className="mt">
              <div className="small mut" style={{ marginBottom: 8 }}>Periode yang dibandingkan · % dihitung terhadap periode pertama</div>
              {periods.map((period, index) => (
                <div key={index} className="filters" style={{ marginBottom: 6 }}>
                  <span className="pdot" style={{ background: CHART_PAL[index], alignSelf: "center" }} />
                  <input type="text" value={period.label} onChange={(event) => setPeriods((rows) => rows.map((row, i) => i === index ? { ...row, label: event.target.value } : row))} />
                  <input type="date" value={period.from} onChange={(event) => setPeriods((rows) => rows.map((row, i) => i === index ? { ...row, from: event.target.value } : row))} />
                  <span className="small">s/d</span>
                  <input type="date" value={period.to} onChange={(event) => setPeriods((rows) => rows.map((row, i) => i === index ? { ...row, to: event.target.value } : row))} />
                  <span className="small mut">{daysBetween(period.from, period.to)} hari</span>
                  {periods.length > 2 ? <button className="btn sm" onClick={() => setPeriods((rows) => rows.filter((_, i) => i !== index))}>✕</button> : null}
                </div>
              ))}
              <button className="btn sm" onClick={() => setPeriods((rows) => [...rows, { label: `Periode ${String.fromCharCode(65 + rows.length)}`, from, to }])}>+ Tambah periode</button>
            </div>
          ) : null}
        </div>
      </div>

      {!report ? <div className="card mt empty">Memuat data…</div> : compare ? (
        <Compare reports={compared} />
      ) : (
        <>
          <div className="grid g6 mt">
            {[
              ["Penjualan kotor", rp(report.kpis.gross), "Σ Sub Total"],
              ["Diskon", rp(report.kpis.disc), report.kpis.gross ? `${((report.kpis.disc / report.kpis.gross) * 100).toFixed(1)}% dari kotor` : ""],
              ["Revenue bersih", rp(report.kpis.net), "Σ Revenue per Unit × Qty"],
              ["Jumlah pesanan", numId(report.kpis.orders), `${report.kpis.days} hari data`],
              ["Qty terjual", `${numId(report.kpis.qty)} pcs`, ""],
              ["AOV", rp(report.kpis.aov), "Revenue bersih / pesanan"],
            ].map(([label, value, hint]) => (
              <div className="card kpi" key={label}><div className="l">{label}</div><div className="v">{value}</div><div className="s">{hint}</div></div>
            ))}
          </div>
          <div className="grid g3 mt">
            <div className="card">
              <h3>Tren penjualan <small>{granularity === "day" ? "harian" : granularity === "week" ? "mingguan" : "bulanan"}</small></h3>
              <BarChart
                labels={report.trend.map((row) => row.label)}
                series={[
                  { name: "Penjualan kotor", values: report.trend.map((row) => row.gross), color: "#c7d2fe" },
                  { name: "Revenue bersih", values: report.trend.map((row) => row.net), color: "#4f46e5" },
                ]}
                line={{ name: "Jumlah pesanan", values: report.trend.map((row) => row.orders), color: "#f59e0b" }}
              />
            </div>
            <div className="card">
              <h3>Penjualan per channel <small>kotor</small></h3>
              <Donut items={report.channels.map((row) => ({ label: row.key || "—", value: row.gross, color: colors[row.key] || "#64748b" }))} />
            </div>
          </div>
          <div className="grid g2 mt">
            <div className="card">
              <h3>Penjualan per toko <small>kotor · {report.stores.length} toko</small></h3>
              <div style={{ maxHeight: 330, overflow: "auto" }}>
                <HBars items={report.stores.map((row, index) => ({ label: row.key || "—", value: row.gross, color: CHART_PAL[index % CHART_PAL.length] }))} />
              </div>
            </div>
            <div className="card">
              <h3 style={{ display: "flex", alignItems: "center" }}>Best seller produk <small>top 10</small><span style={{ flex: 1 }} /><span className="seg">{(["qty", "net"] as const).map((value) => <button key={value} className={best === value ? "on" : ""} onClick={() => setBest(value)}>{value === "qty" ? "Qty" : "Revenue"}</button>)}</span></h3>
              <HBars qty={best === "qty"} items={bestRows.map((row) => ({ label: row.name ? `${row.sku} · ${row.name}` : row.sku, value: best === "qty" ? row.qty : row.net, color: "#6366f1" }))} />
            </div>
          </div>
          <div className="grid g32 mt">
            <div className="card">
              <h3 style={{ display: "flex", gap: 8, alignItems: "center" }}>Penjualan per produk <small>{products.length} SKU</small><span style={{ flex: 1 }} /><input type="text" placeholder="Cari SKU / nama produk…" value={q} onChange={(event) => setQ(event.target.value)} /></h3>
              <div className="tbl">
                <table className="cards">
                  <thead><tr>
                    {([["sku", "SKU"], ["name", "Nama produk"], ["orders", "Pesanan"], ["qty", "Qty"], ["gross", "Kotor"], ["net", "Revenue bersih"], ["share", "Share"]] as const).map(([key, label]) => (
                      <th key={key} className={key === "sku" || key === "name" ? "" : "n"} style={{ cursor: "pointer" }} onClick={() => setSort({ key, dir: sort.key === key ? -sort.dir : -1 })}>{label}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {products.map((row) => (
                      <tr key={row.sku}>
                        <td data-label="SKU"><b>{row.sku}</b></td>
                        <td data-label="Nama" className="small">{row.name}</td>
                        <td data-label="Pesanan" className="n">{numId(row.orders)}</td>
                        <td data-label="Qty" className="n">{numId(row.qty)}</td>
                        <td data-label="Kotor" className="n">{rp(row.gross)}</td>
                        <td data-label="Revenue" className="n"><b>{rp(row.net)}</b></td>
                        <td data-label="Share" className="n">{(row.share * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <h3 style={{ display: "flex" }}>Penjualan per wilayah<span style={{ flex: 1 }} /><span className="seg"><button className={geo === "provinces" ? "on" : ""} onClick={() => setGeo("provinces")}>Provinsi</button><button className={geo === "cities" ? "on" : ""} onClick={() => setGeo("cities")}>Kota</button></span></h3>
              <div className="tbl">
                <table className="cards">
                  <thead><tr><th>{geo === "provinces" ? "Provinsi" : "Kab/Kota"}</th><th className="n">Pesanan</th><th className="n">Revenue bersih</th><th className="n">Share</th></tr></thead>
                  <tbody>
                    {(geo === "provinces" ? report.provinces : report.cities).map((row) => (
                      <tr key={row.key}>
                        <td data-label="Wilayah">{row.key || "—"}</td>
                        <td data-label="Pesanan" className="n">{numId(row.orders)}</td>
                        <td data-label="Revenue" className="n">{rp(row.net)}</td>
                        <td data-label="Share" className="n">{(row.share * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Compare({ reports }: { reports: { label: string; from: string; to: string; report: DashboardReport }[] }) {
  const base = reports[0]?.report.kpis;
  if (!base) return null;
  const metrics = [
    ["gross", "Penjualan kotor", true],
    ["disc", "Diskon", true],
    ["net", "Revenue bersih", true],
    ["orders", "Jumlah pesanan", false],
    ["qty", "Qty terjual", false],
    ["aov", "AOV", true],
  ] as const;
  const channels = [...new Set(reports.flatMap((item) => item.report.channels.map((row) => row.key)))];
  return (
    <>
      <div className="grid g6 mt">
        {metrics.map(([key, label]) => (
          <div className="card kpi" key={key}>
            <div className="l">{label}</div>
            {reports.map((item, index) => (
              <div key={item.label}>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
                  <span className="small"><span className="pdot" style={{ background: CHART_PAL[index] }} /> {item.label}</span>
                  <b>{key === "orders" || key === "qty" ? numId(item.report.kpis[key]) : rpCompact(item.report.kpis[key])}</b>
                </div>
                {index ? <div style={{ textAlign: "right" }}><Pct a={item.report.kpis[key]} b={base[key]} /></div> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="grid g2 mt">
        <div className="card">
          <h3>Ringkasan per periode</h3>
          <div className="tbl">
            <table className="cards">
              <thead>
                <tr>
                  <th>Metrik</th>
                  {reports.map((item) => <th key={item.label} className="n">{item.label}<div className="small mut">{dayShort(item.from)}–{dayShort(item.to)}</div></th>)}
                </tr>
              </thead>
              <tbody>
                {metrics.map(([key, label, money]) => (
                  <tr key={key}>
                    <td data-label="Metrik">{label}</td>
                    {reports.map((item) => <td key={item.label} data-label={item.label} className="n">{money ? rp(item.report.kpis[key]) : numId(item.report.kpis[key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3>Penjualan per channel <small>kotor, per periode</small></h3>
          <BarChart
            labels={channels}
            series={reports.map((item, index) => ({
              name: item.label,
              color: CHART_PAL[index],
              values: channels.map((name) => item.report.channels.find((row) => row.key === name)?.gross ?? 0),
            }))}
          />
        </div>
      </div>
    </>
  );
}
