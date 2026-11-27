"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BarChart, CHART_PAL, Donut } from "@/components/charts";
import { CompletenessBanner, LossRank, MarketingBreakdown, ProductLossList, WaterfallTable, asReady, type LossRankRow, type ProfitRow } from "@/components/dashboard-profit";
import { downloadExport } from "@/components/download";
import { ActionButton, reported, reportedOk, Spinner, TableShell } from "@/components/ui/feedback";
import { Pager, useClientPage } from "@/components/ui/pager";
import { api } from "@/lib/api-client";
import type { DashboardQuery, DashboardReport, FilterOptions, GroupRow, MatrixRow } from "@/lib/db/types";
import { dayShort } from "@/lib/domain/aggregate";
import { feeCoverageRatio, storeProfit } from "@/lib/marketing/allocate";
import { currentMonthRange, lastNDays, previousEqualWindow, previousMonthRange } from "@/lib/domain/phase3";
import { numId, rp, rpCompact } from "@/lib/format";

type Mode = "toko" | "produk";
type Metric = "net" | "gross" | "profit";
type Preset = "month" | "prev" | "oct2026" | "d7" | "d30" | "custom";

const METRIC_LABEL: Record<Metric, string> = {
  net: "Revenue Bersih",
  gross: "Penjualan Kotor",
  profit: "Profit bersih",
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
  const [compare, setCompare] = useState(true);
  const [metric, setMetric] = useState<Metric>("profit");
  const [includeReturns, setIncludeReturns] = useState(false);
  const [optionsReady, setOptionsReady] = useState(false);
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
    }).then((result) => setOptions(result.options)).catch((err: Error) => setError(err.message)).finally(() => setOptionsReady(true));
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
    statuses: status ? [status] : [],
    couriers: [],
    skus: sku ? [sku] : [],
    brands: brand ? [brand] : [],
    categories: category ? [category] : [],
    includeReturns,
  }), [from, to, channel, store, status, sku, brand, category, includeReturns]);

  useEffect(() => {
    const compareWindow = previousEqualWindow(from, to);
    const periods = compare
      ? [{ label: "Periode", from, to }, { label: "Pembanding", from: compareWindow.from, to: compareWindow.to }]
      : [{ label: "Periode", from, to }];
    if (!optionsReady) return;
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
  }, [query, compare, from, to, status, optionsReady]);

  function applyPreset(next: Preset) {
    setPreset(next);
    const today = currentMonthRange().to;
    const range = next === "month" ? currentMonthRange(today)
      : next === "prev" ? previousMonthRange(today)
        : next === "oct2026" ? { from: "2026-10-01", to: "2026-10-31" }
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
    setCompare(true);
    setMetric("profit");
    setIncludeReturns(false);
    setStore("");
    setChannel("");
    setStatus("");
    setSku("");
    setBrand("");
    setCategory("");
  }

  const A = report?.kpis;
  const C = previous?.kpis;
  const headline = A ? (mode === "toko" ? A.net - A.hpp - A.fee - A.marketing : A.profit) : 0;
  const priorHeadline = C ? (mode === "toko" ? C.net - C.hpp - C.fee - C.marketing : C.profit) : undefined;

  function orderHref(extra: { loss?: boolean; unpaid?: boolean; channel?: string; store?: string; skus?: string; sort?: "profit" }) {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (extra.channel) params.set("channels", extra.channel);
    if (extra.store) params.set("stores", extra.store);
    if (extra.skus) params.set("skus", extra.skus);
    if (extra.sort) params.set("sort", extra.sort);
    if (!includeReturns) params.set("excludeReturns", "1");
    if (extra.loss) params.set("loss", "1");
    if (extra.unpaid) params.set("unpaid", "1");
    return `/pesanan?${params.toString()}`;
  }

  function toProfit(row: GroupRow, key = row.key): ProfitRow {
    return {
      key,
      orders: row.orders,
      qty: row.qty,
      net: row.net ?? 0,
      gross: row.gross ?? 0,
      hpp: row.hpp,
      fee: row.fee,
      marketing: row.marketing,
      miss: row.miss,
      mpNet: row.mpNet,
      mpCovered: row.mpCovered,
      returnQty: row.returnQty,
      returnNet: row.returnNet,
    };
  }

  function cellProfit(row: MatrixRow): ProfitRow {
    return {
      key: row.channel,
      orders: row.orders,
      qty: row.qty,
      net: row.net,
      gross: row.gross ?? 0,
      hpp: row.hpp,
      fee: row.fee,
      marketing: row.marketing,
      miss: row.miss,
      mpNet: row.mpNet,
      mpCovered: row.mpCovered,
    };
  }

  const storeProfitRows = (report?.stores ?? []).map((row) => toProfit(row));
  const channelProfitRows = (report?.channels ?? []).map((row) => ({
    ...toProfit(row),
    profit: mode === "toko" ? storeProfit(row.net ?? 0, row.hpp ?? 0, row.fee ?? 0, row.marketing ?? 0) : row.profit,
  }));
  const previousStores = (previous?.stores ?? []).map((row) => toProfit(row));
  const previousChannels = (previous?.channels ?? []).map((row) => toProfit(row));
  const matrixByStore = new Map<string, ProfitRow[]>();
  for (const row of report?.matrix ?? []) {
    const list = matrixByStore.get(row.store) ?? [];
    list.push(cellProfit(row));
    matrixByStore.set(row.store, list);
  }
  const storeRows: ProfitRow[] = storeProfitRows.map((row) => ({ ...row, children: matrixByStore.get(row.key) ?? [] }));
  const channelsBySku = new Map<string, ProfitRow[]>();
  for (const row of report?.productChannels ?? []) {
    const list = channelsBySku.get(row.sku) ?? [];
    list.push({ key: row.channel, orders: row.orders, qty: row.qty, net: row.net, hpp: row.hpp, fee: row.fee, miss: row.miss });
    channelsBySku.set(row.sku, list);
  }
  const productRows: ProfitRow[] = (report?.products ?? []).map((row) => {
    const net = row.net ?? 0;
    const hpp = row.hpp ?? 0;
    const qty = row.qty || 0;
    return {
      ...toProfit(row, row.sku),
      key: row.name ? `${row.sku} · ${row.name}` : row.sku,
      sku: row.sku,
      promo: Math.abs(net) < 1 && hpp > 0,
      anomaly: qty > 0 && net > 0 && hpp / qty > net / qty,
      children: channelsBySku.get(row.sku),
    };
  });
  const previousProducts = (previous?.products ?? []).map((row) => toProfit(row, row.name ? `${row.sku} · ${row.name}` : row.sku));
  const lossRank: LossRankRow[] = [
    ...storeProfitRows.map((row) => {
      const profit = storeProfit(row.net, row.hpp ?? 0, row.fee ?? 0, row.marketing ?? 0);
      const coverage = row.mpNet == null ? null : feeCoverageRatio(row.mpNet, row.mpCovered ?? 0);
      return { id: `store:${row.key}`, store: row.key, channel: "", profit, margin: row.net ? profit / row.net : null, orders: row.orders, net: row.net, provisional: coverage != null && coverage < 0.999 };
    }),
    ...(report?.matrix ?? []).map((row) => {
      const profit = storeProfit(row.net, row.hpp, row.fee, row.marketing ?? 0);
      const coverage = feeCoverageRatio(row.mpNet, row.mpCovered);
      return { id: `cell:${row.store}:${row.channel}`, store: row.store, channel: row.channel, profit, margin: row.net ? profit / row.net : null, orders: row.orders, net: row.net, provisional: coverage != null && coverage < 0.999 };
    }),
  ].filter((row) => row.profit < 0).sort((a, b) => a.profit - b.profit);
  const losingProducts = productRows.map((row) => asReady({ ...row, key: row.key })).filter((row) => row.profit < 0).sort((a, b) => a.profit - b.profit);
  const netRank = [...productRows].sort((a, b) => b.net - a.net);
  const netSum = netRank.reduce((sum, row) => sum + row.net, 0);
  const topShare = (count: number) => netSum ? netRank.slice(0, count).reduce((sum, row) => sum + row.net, 0) / netSum : 0;
  const thinProducts = productRows.map((row) => asReady(row)).filter((row) => row.profit >= 0 && row.margin != null && row.margin < 0.1 && row.net > 0).sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0));

  return (
    <div>
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="pagehead">
        <div className="desc">
          <b>Profit bersih</b> = Revenue − HPP − Biaya platform{mode === "toko" ? " − Marketing" : ""}. <b>Kontribusi sebelum HPP</b> = Revenue − Biaya platform{mode === "toko" ? " − Marketing" : ""}. Batal tidak dihitung. Retur tampil terpisah dan {includeReturns ? "sedang ikut di angka" : "tidak masuk angka utama"}.
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
            <option value="oct2026">Oktober 2026</option>
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
            <option value="">Tanpa batal & retur</option>
            {includeReturns ? <option value="RETURNED">RETURNED</option> : null}
            {(options?.statuses ?? ["PROCESSING", "SHIPPED", "COMPLETED"]).filter((item) => !/return|cancel/i.test(item)).map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>&nbsp;</label>
          <button className={`tog ${includeReturns ? "on" : ""}`} onClick={() => setIncludeReturns((value) => !value)}><i /><b>Sertakan retur</b></button>
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
            <Kpi label="Kontribusi sebelum HPP" value={rpCompact(A.net - A.fee - (mode === "toko" ? A.marketing : 0))} hint="revenue − biaya platform − marketing" current={A.net - A.fee - (mode === "toko" ? A.marketing : 0)} prior={C ? C.net - C.fee - (mode === "toko" ? C.marketing : 0) : undefined} compare={compare} />
            <Kpi label="Profit bersih" value={rpCompact(headline)} hint={A.net ? `margin ${((headline / A.net) * 100).toFixed(1).replace(".", ",")}%` : ""} current={headline} prior={priorHeadline} compare={compare} tone={headline < 0 ? "bad" : "ok"} />
            <Kpi label="Retur (info)" value={A.returnsOrders == null ? "—" : numId(A.returnsOrders)} hint={A.returnsNet == null ? "menunggu migrasi 0018" : rp(A.returnsNet)} current={A.returnsOrders ?? 0} prior={C?.returnsOrders} compare={compare && A.returnsOrders != null} money={false} />
            <Kpi label="Jumlah Pesanan" value={numId(A.orders)} hint="tanpa batal, tanpa retur kecuali dinyalakan" current={A.orders} prior={C?.orders} compare={compare} money={false} />
            <Kpi label="Qty Terjual" value={`${numId(A.qty)} pcs`} hint="" current={A.qty} prior={C?.qty} compare={compare} money={false} />
            <Kpi label="AOV" value={rpCompact(A.aov)} hint="Revenue Bersih ÷ Jumlah Pesanan" current={A.aov} prior={C?.aov} compare={compare} />
          </div>
          {A.missingSkus ? (
            <div className="warnbox mt"><b>{A.missingSkus} SKU belum punya HPP</b> di periode ini — dihitung <b>Rp0</b>, sehingga Profit terlihat lebih besar dari seharusnya.{A.missingSkuSample?.length ? ` Contoh: ${A.missingSkuSample.join(", ")}.` : ""} <a href="/produk/hpp">Lengkapi di Master Data › HPP</a></div>
          ) : null}
          <CompletenessBanner mpNet={A.mpNet} mpCovered={A.mpCovered} marketingThrough={report?.marketingThrough} periodTo={to} returnsOrders={A.returnsOrders} returnsNet={A.returnsNet} includeReturns={includeReturns} />
          <div className="formula"><b>Profit bersih</b> = Revenue <b>{rp(A.net)}</b> − HPP <b>{rp(A.hpp)}</b> − Biaya platform <b>{rp(A.fee)}</b>{mode === "toko" ? <> − Marketing <b>{rp(A.marketing)}</b></> : null} = <b>{rp(headline)}</b>. Kontribusi sebelum HPP = <b>{rp(A.net - A.fee - (mode === "toko" ? A.marketing : 0))}</b>.</div>
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
              <LossRank
                title="Toko/channel penyebab rugi"
                hint="profit bersih paling negatif di atas · sudah termasuk marketing · klik membuka pesanan (profit pesanan = revenue − HPP − biaya platform, tanpa marketing)"
                rows={lossRank}
                loading={loading}
                href={(row) => orderHref({ loss: true, channel: row.channel, store: row.store, sort: "profit" })}
              />
              <WaterfallTable title="Penjualan per Toko" hint="urut dari profit bersih terendah · baris bisa dibuka per channel" rows={storeRows} compareRows={compare ? previousStores : undefined} loading={loading} withMarketing expandable marketingThroughByStore={report?.marketingThroughByStore} periodTo={to} />
              <WaterfallTable title="Penjualan per Channel" rows={channelProfitRows} compareRows={compare ? previousChannels : undefined} loading={loading} withMarketing marketingThrough={report?.marketingThrough} periodTo={to} />
              <MarketingBreakdown rows={report?.marketingLines ?? []} loading={loading} />
              <StoreMoneyList
                title="Pesanan rugi"
                hint="profit pesanan di bawah nol: revenue − HPP − biaya platform, tanpa marketing · klik untuk membuka pesanan"
                rows={report?.lossStores ?? []}
                valueLabel="Total rugi"
                loading={loading}
                href={(row) => orderHref({ loss: true, channel: row.channel, store: row.storeName, sort: "profit" })}
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
              <div className="card mt"><h3>Penjualan per Channel <small>Profit bersih</small></h3><Donut items={channelProfitRows.filter((row) => (row.profit ?? 0) > 0).map((row, index) => ({ label: row.key || "—", value: row.profit ?? 0, color: CHART_PAL[index % CHART_PAL.length] }))} />{channelProfitRows.some((row) => (row.profit ?? 0) < 0) ? <div className="mut small">Channel dengan profit negatif tidak masuk donat. Lihat Toko/channel penyebab rugi.</div> : null}</div>
            </>
          ) : (
            <>
              <ProductLossList title="Produk rugi" hint="profit = revenue − HPP − biaya platform, paling negatif di atas · klik membuka pesanan SKU itu" rows={losingProducts} loading={loading} href={(row) => orderHref({ skus: row.sku || row.key, sort: "profit" })} empty="Tidak ada produk dengan profit di bawah nol." />
              <ProductLossList title="Margin tipis (<10%)" hint="masih untung, margin di bawah 10%" rows={thinProducts} loading={loading} href={(row) => orderHref({ skus: row.sku || row.key, sort: "profit" })} empty="Tidak ada produk dengan margin di bawah 10%." />
              <TopProfit rows={report?.topProfit ?? []} loading={loading} />
              <div className="note mt">10 SKU teratas {(topShare(10) * 100).toFixed(1).replace(".", ",")}% revenue. 20 SKU teratas {(topShare(20) * 100).toFixed(1).replace(".", ",")}% revenue. {losingProducts.length} SKU rugi, total {rp(losingProducts.reduce((sum, row) => sum + row.profit, 0))}.</div>
              <WaterfallTable title="Penjualan per Produk" rows={productRows} compareRows={compare ? previousProducts : undefined} loading={loading} withMarketing={false} showUnits showReturns />
              <WaterfallTable title="Penjualan per Kategori" rows={(report?.categories ?? []).map((row) => toProfit(row))} compareRows={compare ? (previous?.categories ?? []).map((row) => toProfit(row)) : undefined} loading={loading} withMarketing={false} />
              <WaterfallTable title="Penjualan per Brand" rows={(report?.brands ?? []).map((row) => toProfit(row))} compareRows={compare ? (previous?.brands ?? []).map((row) => toProfit(row)) : undefined} loading={loading} withMarketing={false} />
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
            <Best title={mode === "toko" ? "Best Seller Brand" : "Best Seller Channel"} rows={mode === "toko" ? (report?.brands ?? []) : channelProfitRows.map((row) => ({ key: row.key, gross: row.gross ?? 0, net: row.net, qty: row.qty, orders: row.orders, hpp: row.hpp, fee: row.fee, marketing: row.marketing, profit: row.profit ?? 0 }))} metric={metric} />
          </div>
          <div className="note mt">
            <b>Catatan perhitungan</b>
            <ul>
              <li><b>Profit bersih</b> = Revenue − HPP − Biaya platform{mode === "toko" ? " − Marketing" : ""}. <b>Kontribusi sebelum HPP</b> = Revenue − Biaya platform{mode === "toko" ? " − Marketing" : ""}. HPP yang belum ada dihitung 0 dan ditandai HPP belum lengkap.</li>
              <li><b>Biaya platform</b> dari impor pembayaran. PPh dicatat tetapi tidak mengurangi profit. Biaya iklan GMV Max dan Voucher GMV Max dicatat tetapi tidak dipotong di sini, karena sudah masuk Marketing.</li>
              <li><b>Marketing</b> diprorata per hari. TikTok Ads dibagi ke TikTok dan Tokopedia menurut revenue toko itu. Shopee Ads, CPAS, dan Meta Ads masuk ke Shopee. Meta tetap baris sendiri di rincian. Filter channel hanya memotong iklan channel itu.</li>
              <li><b>Profit produk</b> tidak memotong marketing. Marketing hanya di tingkat toko dan channel. Profit satu pesanan = revenue − HPP − biaya platform.</li>
              <li>Pesanan <b>batal</b> tidak dihitung. <b>Retur</b> tetap ada di data dan ditampilkan sebagai angka info. Angka utama mengikutkannya hanya bila Sertakan retur nyala. Pesanan Dihapus tidak dihitung. Pesanan -R (harga 0) ikut sebagai biaya promosi bila revenue-nya nol.</li>
              <li>Profit bertanda <b>Sementara</b> bila biaya platform belum menutup 100% revenue marketplace, atau data marketing berhenti sebelum akhir periode.</li>
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
