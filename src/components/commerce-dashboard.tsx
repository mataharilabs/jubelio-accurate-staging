"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BarChart, CHART_PAL, Donut } from "@/components/charts";
import { downloadExport } from "@/components/download";
import { ActionButton, reported, reportedOk, Spinner, TableShell } from "@/components/ui/feedback";
import { Pager, useClientPage } from "@/components/ui/pager";
import { api } from "@/lib/api-client";
import type { DashboardQuery, DashboardReport, FilterOptions, GroupRow } from "@/lib/db/types";
import { dayShort } from "@/lib/domain/aggregate";
import { storeProfit } from "@/lib/marketing/allocate";
import { currentMonthRange, lastNDays, previousEqualWindow, previousMonthRange } from "@/lib/domain/phase3";
import { numId, rp, rpCompact } from "@/lib/format";

type Mode = "toko" | "produk";
type Metric = "net" | "gross" | "profit";
type Preset = "month" | "prev" | "d7" | "d30" | "custom";

const METRIC_LABEL: Record<Metric, string> = {
  net: "Revenue Bersih",
  gross: "Penjualan Kotor",
  profit: "Profit",
};

function trendValue(row: { gross?: number; net?: number; profit?: number; marketing?: number; hpp?: number; fee?: number } | undefined, metric: Metric, storeMode: boolean): number {
  if (storeMode && metric === "profit") return storeProfit(row?.net ?? 0, row?.hpp ?? 0, row?.fee ?? 0, row?.marketing ?? 0);
  return metricOf(row, metric);
}

function metricOf(row: { gross?: number; net?: number; profit?: number } | undefined, metric: Metric): number {
  if (!row) return 0;
  if (metric === "gross") return row.gross ?? 0;
  if (metric === "profit") return row.profit ?? 0;
  return row.net ?? 0;
}

function pct(current: number, previous: number) {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function CommerceDashboard({ mode }: { mode: Mode }) {
  const [options, setOptions] = useState<FilterOptions & { brands?: string[]; categories?: string[] } | null>(null);
  const [catalog, setCatalog] = useState<{ brands: { name: string }[]; categories: { name: string }[]; skus: { sku: string; name: string }[] }>({ brands: [], categories: [], skus: [] });
  const [preset, setPreset] = useState<Preset>("month");
  const initial = currentMonthRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [compare, setCompare] = useState(false);
  const [metric, setMetric] = useState<Metric>("net");
  const [store, setStore] = useState("");
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [sku, setSku] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [geo, setGeo] = useState<"provinces" | "cities">("provinces");
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [previous, setPrevious] = useState<DashboardReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ reports: { report: DashboardReport }[]; options: FilterOptions }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query: { ...currentMonthRange(), granularity: "day" }, includeOptions: true }),
    }).then((result) => setOptions(result.options)).catch((err: Error) => setError(err.message));
    if (mode === "produk") {
      Promise.all([
        api<{ id: string; name: string }[]>("/api/catalog/merek"),
        api<{ id: string; name: string }[]>("/api/catalog/kategori"),
        api<{ rows: { sku: string; name: string }[] }>("/api/products?dataStatus=active"),
      ]).then(([brands, categories, products]) => {
        setCatalog({ brands, categories, skus: products.rows ?? [] });
      }).catch(() => undefined);
    }
  }, [mode]);

  const query = useMemo<DashboardQuery>(() => ({
    from,
    to,
    granularity: "day",
    channels: channel ? [channel] : [],
    stores: store ? [store] : [],
    provinces: [],
    cities: [],
    statuses: status === "xrc"
      ? ((options?.statuses ?? ["PROCESSING", "SHIPPED", "COMPLETED"]).filter((item) => !/return|cancel/i.test(item)))
      : status ? [status] : [],
    couriers: [],
    skus: sku ? [sku] : [],
    brands: brand ? [brand] : [],
    categories: category ? [category] : [],
  }), [from, to, channel, store, status, sku, brand, category, options]);

  useEffect(() => {
    const compareWindow = previousEqualWindow(from, to);
    const periods = compare
      ? [{ label: "Periode", from, to }, { label: "Pembanding", from: compareWindow.from, to: compareWindow.to }]
      : [{ label: "Periode", from, to }];
    let cancel = false;
    setLoading(true);
    api<{ reports: { report: DashboardReport }[] }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query, periods }),
    }).then((result) => {
      if (cancel) return;
      setReport(result.reports[0]?.report ?? null);
      setPrevious(compare ? result.reports[1]?.report ?? null : null);
      setError(null);
    }).catch((err: Error) => { if (!cancel) setError(reported(err, "Gagal memuat dashboard.")); }).finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [query, compare, from, to, status]);

  function applyPreset(next: Preset) {
    setPreset(next);
    const today = currentMonthRange().to;
    const range = next === "month" ? currentMonthRange(today)
      : next === "prev" ? previousMonthRange(today)
        : next === "d7" ? lastNDays(7, today)
          : next === "d30" ? lastNDays(30, today)
            : null;
    if (range) {
      setFrom(range.from);
      setTo(range.to);
    }
  }

  function reset() {
    const range = currentMonthRange();
    setPreset("month");
    setFrom(range.from);
    setTo(range.to);
    setCompare(false);
    setMetric("net");
    setStore("");
    setChannel("");
    setStatus("");
    setSku("");
    setBrand("");
    setCategory("");
  }

  const A = report?.kpis;
  const C = previous?.kpis;
  const profitLabel = mode === "toko" ? "Profit Toko" : "Profit Produk";

  function orderHref(extra: { loss?: boolean; unpaid?: boolean; channel: string; store: string }) {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (extra.channel) params.set("channels", extra.channel);
    if (extra.store) params.set("stores", extra.store);
    if (query.statuses.length) params.set("statuses", query.statuses.join(","));
    if (extra.loss) params.set("loss", "1");
    if (extra.unpaid) params.set("unpaid", "1");
    return `/pesanan?${params.toString()}`;
  }

  return (
    <div>
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="pagehead">
        <div className="desc">
          <b>{profitLabel}</b> = Revenue Bersih − HPP − Biaya Platform{mode === "toko" ? " − Marketing Spending" : " (Marketing = 0)"}. Default periode: <b>bulan berjalan</b>. Pesanan berstatus data <b>Dihapus</b> tidak dihitung.
        </div>
        <div className="actions">
          <ActionButton className="btn" onClick={() => downloadExport(mode === "toko" ? "dashboard-toko.xlsx" : "dashboard-produk.xlsx", { target: "dashboard", format: "xlsx", query, mode }).then(() => reportedOk("Ekspor selesai.")).catch((err: Error) => setError(reported(err, "Ekspor gagal.")))}>Export</ActionButton>
        </div>
      </div>
      <div className="filterbar">
        {mode === "toko" ? (
          <div className="f"><label>Toko</label>
            <select value={store} onChange={(event) => setStore(event.target.value)}><option value="">Semua toko</option>{(options?.stores ?? []).map((item) => <option key={item}>{item}</option>)}</select>
          </div>
        ) : (
          <div className="f"><label>Produk</label>
            <select value={sku} onChange={(event) => setSku(event.target.value)}><option value="">Semua produk</option>{catalog.skus.slice(0, 400).map((item) => <option key={item.sku} value={item.sku}>{item.sku} · {item.name}</option>)}</select>
          </div>
        )}
        <div className="f"><label>Periode</label>
          <select value={preset} onChange={(event) => applyPreset(event.target.value as Preset)}>
            <option value="month">Bulan berjalan</option>
            <option value="prev">Bulan lalu</option>
            <option value="d7">7 hari terakhir</option>
            <option value="d30">30 hari terakhir</option>
            <option value="custom">Pilih tanggal…</option>
          </select>
        </div>
        {preset === "custom" ? (
          <div className="f"><label>Tanggal</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              <span className="mut">s/d</span>
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
          </div>
        ) : null}
        <div className="f"><label>Metrik grafik</label>
          <div className="seg">{(["net", "gross", "profit"] as Metric[]).map((item) => <button key={item} className={metric === item ? "on" : ""} onClick={() => setMetric(item)}>{METRIC_LABEL[item]}</button>)}</div>
        </div>
        <div className="f"><label>Status pesanan</label>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Semua status (termasuk Returned)</option>
            <option value="xrc">Tanpa Returned & Canceled</option>
            {(options?.statuses ?? ["PROCESSING", "SHIPPED", "COMPLETED", "RETURNED", "CANCELED"]).map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        {mode === "toko" ? (
          <div className="f"><label>Channel</label>
            <select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="">Semua channel</option>{(options?.channels ?? []).map((item) => <option key={item}>{item}</option>)}</select>
          </div>
        ) : (
          <>
            <div className="f"><label>Brand</label>
              <select value={brand} onChange={(event) => setBrand(event.target.value)}><option value="">Semua brand</option>{catalog.brands.map((item) => <option key={item.name}>{item.name}</option>)}</select>
            </div>
            <div className="f"><label>Kategori</label>
              <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Semua kategori</option>{catalog.categories.map((item) => <option key={item.name}>{item.name}</option>)}</select>
            </div>
          </>
        )}
        <div className="f"><label>&nbsp;</label>
          <button className={`tog ${compare ? "on" : ""}`} onClick={() => setCompare((value) => !value)}><i /><b>Bandingkan periode</b></button>
        </div>
        <div className="f"><label>&nbsp;</label><button className="btn ghost" onClick={reset}>Reset filter</button></div>
      </div>
      {A ? (
        <>
          <div className="grid g5">
            <Kpi label="Penjualan Kotor" value={rpCompact(A.gross)} hint="sebelum diskon" current={A.gross} prior={C?.gross} compare={compare} />
            <Kpi label="Diskon" value={rpCompact(A.disc)} hint={A.gross ? `${((A.disc / A.gross) * 100).toFixed(1).replace(".", ",")}% dari kotor` : ""} current={A.disc} prior={C?.disc} compare={compare} invert />
            <Kpi label="Revenue Bersih" value={rpCompact(A.net)} hint="kotor − diskon" current={A.net} prior={C?.net} compare={compare} />
            <Kpi label="Total HPP" value={rpCompact(A.hpp)} hint={A.missingSkus ? `${A.missingSkus} SKU belum ada HPP (dihitung 0)` : "DPP × 1,11 (inkl. PPN)"} current={A.hpp} prior={C?.hpp} compare={compare} invert />
            <Kpi label="Total Biaya Platform" value={rpCompact(A.fee)} hint="dari impor pembayaran · pajak tidak dipotong" current={A.fee} prior={C?.fee} compare={compare} invert />
            <Kpi label="Total Marketing Spending" value={rpCompact(mode === "toko" ? A.marketing : 0)} hint={mode === "toko" ? "dari Master Marketing Spending · apa adanya dari report" : "tidak dipotong dari profit produk"} current={mode === "toko" ? A.marketing : 0} prior={mode === "toko" ? C?.marketing : 0} compare={compare && mode === "toko"} invert />
            <Kpi label="Total Profit" value={rpCompact(mode === "toko" ? A.net - A.hpp - A.fee - A.marketing : A.profit)} hint={A.net ? `margin ${(((mode === "toko" ? A.net - A.hpp - A.fee - A.marketing : A.profit) / A.net) * 100).toFixed(1).replace(".", ",")}%` : ""} current={mode === "toko" ? A.net - A.hpp - A.fee - A.marketing : A.profit} prior={C ? (mode === "toko" ? C.net - C.hpp - C.fee - C.marketing : C.profit) : undefined} compare={compare} tone={(mode === "toko" ? A.net - A.hpp - A.fee - A.marketing : A.profit) < 0 ? "bad" : "ok"} />
            <Kpi label="Jumlah Pesanan" value={numId(A.orders)} hint="tidak termasuk Dihapus" current={A.orders} prior={C?.orders} compare={compare} money={false} />
            <Kpi label="Qty Terjual" value={`${numId(A.qty)} pcs`} hint="" current={A.qty} prior={C?.qty} compare={compare} money={false} />
            <Kpi label="AOV" value={rpCompact(A.aov)} hint="Revenue Bersih ÷ Jumlah Pesanan" current={A.aov} prior={C?.aov} compare={compare} />
          </div>
          {A.missingSkus ? (
            <div className="warnbox mt"><b>{A.missingSkus} SKU belum punya HPP</b> di periode ini — dihitung <b>Rp0</b>, sehingga Profit terlihat lebih besar dari seharusnya.{A.missingSkuSample?.length ? ` Contoh: ${A.missingSkuSample.join(", ")}.` : ""} <a href="/produk/hpp">Lengkapi di Master Data › HPP</a></div>
          ) : null}
          <div className="formula"><b>{profitLabel}</b> = Revenue Bersih <b>{rp(A.net)}</b> − HPP <b>{rp(A.hpp)}</b> − Biaya Platform <b>{rp(A.fee)}</b>{mode === "toko" ? <> − Marketing Spending <b>{rp(A.marketing)}</b></> : <> − Marketing <b>Rp0</b></>} = <b>{rp(mode === "toko" ? A.net - A.hpp - A.fee - A.marketing : A.profit)}</b></div>
          <div className="card mt">
            <h3>Tren Penjualan <small>{METRIC_LABEL[metric]} per hari</small></h3>
            <BarChart
              labels={(report?.trend ?? []).map((row) => dayShort(row.bucket))}
              series={[
                ...(compare && previous ? [{ name: "Pembanding", values: align(previous.trend, report?.trend ?? []).map((row) => trendValue(row, metric, mode === "toko")), color: "#c9cde0" }] : []),
                { name: METRIC_LABEL[metric], values: (report?.trend ?? []).map((row) => trendValue(row, metric, mode === "toko")), color: "#4f46e5" },
              ]}
            />
          </div>
          {mode === "toko" ? (
            <>
              <PerTable title="Penjualan per Toko" rows={(report?.stores ?? []).map((row) => ({ ...row, marketing: row.marketing ?? 0, profit: storeProfit(row.net ?? 0, row.hpp ?? 0, row.fee ?? 0, row.marketing ?? 0) }))} compareRows={(previous?.stores ?? []).map((row) => ({ ...row, marketing: row.marketing ?? 0, profit: storeProfit(row.net ?? 0, row.hpp ?? 0, row.fee ?? 0, row.marketing ?? 0) }))} metric={metric} compare={compare} showMarketing />
              <PerTable title="Penjualan per Channel" rows={report?.channels ?? []} compareRows={previous?.channels} metric={metric} compare={compare} />
              <StoreMoneyList
                title="Pesanan rugi"
                hint="profit di bawah nol, selain batal, termasuk retur dan channel internal · klik untuk membuka pesanan"
                rows={report?.lossStores ?? []}
                valueLabel="Total rugi"
                loading={loading}
                href={(row) => orderHref({ loss: true, channel: row.channel, store: row.storeName })}
                value={(row) => row.loss ?? 0}
              />
              <StoreMoneyList
                title="Belum ada pembayaran"
                hint="revenue bukan nol, belum ada settlement atau pembayaran · klik untuk membuka pesanan"
                rows={report?.unpaidStores ?? []}
                valueLabel="Revenue bersih"
                loading={loading}
                href={(row) => orderHref({ unpaid: true, channel: row.channel, store: row.storeName })}
                value={(row) => row.net ?? 0}
              />
              <div className="card mt"><h3>Penjualan per Channel <small>{METRIC_LABEL[metric]}</small></h3><Donut items={(report?.channels ?? []).map((row, index) => ({ label: row.key || "—", value: Math.max(0, metricOf(row, metric)), color: CHART_PAL[index % CHART_PAL.length] }))} /></div>
            </>
          ) : (
            <>
              <TopProfit rows={report?.topProfit ?? []} loading={loading} />
              <PerTable title="Penjualan per Produk" rows={(report?.products ?? []).map((row) => ({ ...row, key: row.name ? `${row.sku} · ${row.name}` : row.sku }))} compareRows={previous?.products} metric={metric} compare={compare} defaultSize={10} />
              <PerTable title="Penjualan per Kategori" rows={report?.categories ?? []} compareRows={previous?.categories} metric={metric} compare={compare} />
              <PerTable title="Penjualan per Brand" rows={report?.brands ?? []} compareRows={previous?.brands} metric={metric} compare={compare} defaultSize={10} />
            </>
          )}
          <div className="tablecard mt">
            <div className="th3"><b>Penjualan per Provinsi / Kota</b>
              <div className="seg sm" style={{ marginLeft: "auto" }}>
                <button className={geo === "provinces" ? "on" : ""} onClick={() => setGeo("provinces")}>Provinsi</button>
                <button className={geo === "cities" ? "on" : ""} onClick={() => setGeo("cities")}>Kota</button>
              </div>
            </div>
            <PerBody rows={(geo === "provinces" ? report?.provinces : report?.cities) ?? []} compareRows={geo === "provinces" ? previous?.provinces : previous?.cities} metric={metric} compare={compare} defaultSize={10} tableKey={geo} col={geo === "provinces" ? "Provinsi" : "Kota"} />
          </div>
          <div className="grid g2 mt">
            <Best title={mode === "toko" ? "Best Seller Produk" : "Best Seller Toko"} rows={mode === "toko" ? (report?.products ?? []).map((row) => ({ ...row, key: row.name || row.sku })) : (report?.stores ?? [])} metric={metric} />
            <Best title={mode === "toko" ? "Best Seller Brand" : "Best Seller Channel"} rows={mode === "toko" ? (report?.brands ?? []) : (report?.channels ?? [])} metric={metric} />
          </div>
          <div className="note mt">
            <b>Catatan perhitungan</b>
            <ul>
              <li><b>{profitLabel}</b> = Revenue Bersih − HPP − Biaya Platform{mode === "toko" ? " − Marketing Spending" : ". Marketing ditampilkan 0"}.</li>
              <li><b>Biaya Platform</b> dari impor pembayaran. Pajak (PPh) dicatat tetapi tidak mengurangi profit. HPP yang belum ada dihitung 0.</li>
              <li><b>Marketing Spending</b> mengikuti periode dan filter toko, apa adanya dari report (tanpa PPN). Spend mingguan dihitung utuh bila periodenya masuk jendela, dan diprorata per hari bila hanya sebagian. Tidak dipecah per channel atau SKU. Profit toko menguranginya; profit produk tidak.</li>
              <li><b>HPP</b> = HPP Accurate bulan pesanan (posisi tanggal 1) = DPP × 1,11. Jika snapshot bulan hilang, dipakai bulan sebelumnya. SKU yang sama sekali belum punya HPP dihitung 0.</li>
              <li>Pesanan <b>Dihapus</b> tidak dihitung. Pesanan <b>-R</b> (Barang Hilang, harga 0) ikut dihitung. RETURNED ikut kecuali difilter keluar.</li>
              <li><b>Belum ada pembayaran</b> adalah pesanan yang revenue-nya bukan nol dan belum punya settlement maupun catatan pembayaran. Revenue nol dihitung lunas. Semua channel ikut, termasuk website, offline, dan POS. Retur tetap dihitung.</li>
            </ul>
          </div>
        </>
      ) : <div className="card" style={{ position: "relative" }}>{loading ? <div className="table-loading" role="status"><Spinner /> Memuat…</div> : "Memuat…"}</div>}
    </div>
  );
}

function StoreMoneyList({ title, hint, rows, valueLabel, loading, href, value }: {
  title: string;
  hint: string;
  rows: { channel: string; storeName: string; orders: number; loss?: number; net?: number }[];
  valueLabel: string;
  loading: boolean;
  href: (row: { channel: string; storeName: string; orders: number }) => string;
  value: (row: { loss?: number; net?: number }) => number;
}) {
  const page = useClientPage(rows, `dash-${title}`, 10);
  return (
    <div className="tablecard mt">
      <div className="th3"><b>{title}</b> <small className="mut">{hint}</small></div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small cards">
            <thead><tr><th>Channel</th><th>Toko</th><th className="n">Pesanan</th><th className="n">{valueLabel}</th></tr></thead>
            <tbody>
              {page.shown.map((row) => (
                <tr key={`${row.channel}-${row.storeName}`}>
                  <td data-label="Channel"><Link href={href(row)}>{row.channel || "—"}</Link></td>
                  <td data-label="Toko"><Link href={href(row)}>{row.storeName || "—"}</Link></td>
                  <td data-label="Pesanan" className="n">{numId(row.orders)}</td>
                  <td data-label={valueLabel} className="n">{rp(value(row))}</td>
                </tr>
              ))}
              {!page.shown.length ? <tr><td colSpan={4} className="mut">Tidak ada data</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
      </TableShell>
    </div>
  );
}

function TopProfit({ rows, loading }: { rows: NonNullable<DashboardReport["topProfit"]>; loading: boolean }) {
  const top = rows.slice(0, 10);
  return (
    <div className="tablecard mt">
      <div className="th3"><b>Top 10 produk menurut profit</b> <small className="mut">revenue bersih − HPP − biaya SKU</small></div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small cards">
            <thead><tr><th>SKU</th><th className="n">Qty</th><th className="n">Revenue bersih</th><th className="n">Profit</th></tr></thead>
            <tbody>
              {top.map((row) => (
                <tr key={row.sku}>
                  <td data-label="SKU">{row.sku}<div className="mut">{row.name}</div>{row.miss ? <div className="pill p-warn">HPP belum lengkap</div> : null}</td>
                  <td data-label="Qty" className="n">{numId(row.qty)}</td>
                  <td data-label="Revenue" className="n">{rp(row.net)}</td>
                  <td data-label="Profit" className="n">{rp(row.profit ?? 0)}</td>
                </tr>
              ))}
              {!top.length ? <tr><td colSpan={4} className="mut">Tidak ada data</td></tr> : null}
            </tbody>
          </table>
        </div>
      </TableShell>
    </div>
  );
}

function align(source: DashboardReport["trend"], target: DashboardReport["trend"]) {
  return target.map((_, index) => source[index]);
}

function Kpi({ label, value, hint, current, prior, compare, invert, money = true, tone }: { label: string; value: string; hint: string; current: number; prior?: number; compare: boolean; invert?: boolean; money?: boolean; tone?: "ok" | "bad" }) {
  const delta = compare && prior != null ? pct(current, prior) : null;
  const good = delta == null ? true : invert ? delta <= 0 : delta >= 0;
  return (
    <div className="card kpi">
      <div className="l">{label}</div>
      <div className="v" style={tone ? { color: tone === "bad" ? "var(--bad)" : "var(--ok)" } : undefined}>{value}</div>
      <div className="s">{hint}</div>
      {compare ? <div className="s cmpv">{delta == null ? "—" : <span className={good ? "up" : "dn"}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1).replace(".", ",")}%</span>} {prior != null ? <span className="mut">vs {money ? rpCompact(prior) : numId(prior)}</span> : null}</div> : null}
    </div>
  );
}

function PerTable({ title, rows, compareRows, metric, compare, defaultSize = 25, showMarketing = false }: { title: string; rows: GroupRow[]; compareRows?: GroupRow[]; metric: Metric; compare: boolean; defaultSize?: number; showMarketing?: boolean }) {
  return (
    <div className="tablecard mt">
      <div className="th3"><b>{title}</b> <small className="mut">urut {METRIC_LABEL[metric]}</small></div>
      <PerBody rows={rows} compareRows={compareRows} metric={metric} compare={compare} defaultSize={defaultSize} tableKey={title} col={title.replace("Penjualan per ", "")} showMarketing={showMarketing} />
    </div>
  );
}

function PerBody({ rows, compareRows, metric, compare, col, tableKey, defaultSize = 25, showMarketing = false }: { rows: { key: string; gross?: number; net?: number; qty: number; orders: number; profit?: number; marketing?: number; miss?: boolean }[]; compareRows?: { key: string; gross?: number; net?: number; qty: number; orders: number; profit?: number; marketing?: number; miss?: boolean }[]; metric: Metric; compare: boolean; col: string; tableKey: string; defaultSize?: number; showMarketing?: boolean }) {
  const sorted = [...rows].sort((a, b) => metricOf(b, metric) - metricOf(a, metric));
  const page = useClientPage(sorted, `dash-${tableKey}-${metric}`, defaultSize);
  const shown = page.shown;
  const total = sorted.reduce((sum, row) => sum + Math.max(0, metricOf(row, metric)), 0) || 1;
  const prior = new Map((compareRows ?? []).map((row) => [row.key, row]));
  return (
    <>
    <div className="tscroll"><table>
      <thead><tr><th>{col}</th><th className="n">Pesanan</th><th className="n">Qty</th><th className={metric === "gross" ? "n hl" : "n"}>Penjualan Kotor</th><th className={metric === "net" ? "n hl" : "n"}>Revenue Bersih</th>{showMarketing ? <th className="n">Marketing</th> : null}<th className={metric === "profit" ? "n hl" : "n"}>Profit</th><th className="n">Porsi</th>{compare ? <th className="n">vs periode</th> : null}</tr></thead>
      <tbody>
        {shown.map((row) => {
          const share = Math.max(0, metricOf(row, metric)) / total * 100;
          const before = prior.get(row.key);
          const delta = pct(metricOf(row, metric), metricOf(before, metric));
          return (
            <tr key={row.key || "kosong"}>
              <td>{row.key || "—"}{row.miss ? <div className="pill p-warn">HPP belum lengkap</div> : null}</td>
              <td className="n">{numId(row.orders)}</td>
              <td className="n">{numId(row.qty)}</td>
              <td className="n">{rp(row.gross)}</td>
              <td className="n">{rp(row.net)}</td>
              {showMarketing ? <td className="n">{rp(row.marketing ?? 0)}</td> : null}
              <td className="n">{rp(row.profit ?? 0)}</td>
              <td className="n">{share.toFixed(1).replace(".", ",")}%</td>
              {compare ? <td className="n">{delta == null ? "—" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1).replace(".", ",")}%`}</td> : null}
            </tr>
          );
        })}
        {!shown.length ? <tr><td colSpan={8 + (showMarketing ? 1 : 0)} className="mut">Tidak ada data</td></tr> : null}
      </tbody>
    </table></div>
    <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
    </>
  );
}

function Best({ title, rows, metric }: { title: string; rows: GroupRow[]; metric: Metric }) {
  const sorted = [...rows].sort((a, b) => metricOf(b, metric) - metricOf(a, metric));
  const page = useClientPage(sorted, `best-${title}`, 10);
  const max = Math.max(1, ...page.shown.map((row) => metricOf(row, metric)));
  return (
    <div className="card">
      <h3>{title} <small>urut {METRIC_LABEL[metric]}</small></h3>
      <table className="rank">{page.shown.map((row, index) => (
        <tr key={row.key}><td className="no">{page.page * page.pageSize + index + 1}</td><td><div className="small">{row.key}</div><div className="bar-in"><i style={{ width: `${Math.max(1, metricOf(row, metric) / max * 100)}%` }} /></div></td><td className="n small"><b>{rpCompact(metricOf(row, metric))}</b><div className="mut">{numId(row.qty)} pcs</div></td></tr>
      ))}</table>
      {!page.total ? <div className="mut small">Tidak ada data</div> : null}
      <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
    </div>
  );
}
