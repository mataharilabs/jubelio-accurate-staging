"use client";

import { useEffect, useMemo, useState } from "react";
import { api, track } from "@/lib/api-client";
import { rp, rpCompact } from "@/lib/format";
import { formatPeriod, monthLabel, sameCalendarMonth, wibMonth } from "@/lib/marketing/dates";
import { formatCount, formatPct, formatRatio, metricsOf, sumMetrics } from "@/lib/marketing/metrics";
import { filterMarketingRows } from "@/lib/marketing/query";
import { PLATFORMS, type MarketingRecord, type SpendSource } from "@/lib/marketing/types";
import { ActionButton, reported, reportedOk, Spinner, TableShell } from "@/components/ui/feedback";
import { Pager, useClientPage } from "@/components/ui/pager";

const UPLOAD_PLATFORMS = ["Shopee Ads", "TikTok Ads", "Meta Ads", "CPAS", "Lazada Ads", "Blibli Ads", "Lainnya", "Template Excel"];
const COLUMNS = [
  { key: "periode", label: "Periode", metric: false },
  { key: "platform", label: "Platform", metric: false },
  { key: "toko", label: "Toko", metric: false },
  { key: "kampanye", label: "Nama kampanye / iklan", metric: false },
  { key: "spend", label: "Spend", metric: false },
  { key: "impresi", label: "Impresi", metric: false },
  { key: "klik", label: "Klik", metric: false },
  { key: "pesanan", label: "Pesanan iklan", metric: false },
  { key: "omzet", label: "Omzet iklan", metric: false },
  { key: "ctr", label: "CTR", metric: true },
  { key: "cpc", label: "CPC", metric: true },
  { key: "cpm", label: "CPM", metric: true },
  { key: "cvr", label: "CVR", metric: true },
  { key: "cpo", label: "CPO", metric: true },
  { key: "roas", label: "ROAS", metric: true },
  { key: "acos", label: "ACOS", metric: true },
  { key: "sumber", label: "Sumber", metric: false },
  { key: "diinput", label: "Diinput", metric: false },
  { key: "status", label: "Status data", metric: false },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];
type PreviewRow = {
  lineNo: number;
  periodLabel: string;
  platform: string;
  storeName: string | null;
  campaign: string;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  adsRevenue: number | null;
  metrics: ReturnType<typeof metricsOf>;
};
type Preview = {
  filename: string;
  kind: string;
  platform: string;
  storeRaw: string | null;
  storeMatch: string | null;
  needsStore: boolean;
  unresolved: string[];
  periodLabel: string;
  readCount: number;
  validCount: number;
  skipped: { row: number; reason: string }[];
  crossesMonth: boolean;
  monthMessage: string | null;
  note: string | null;
  duplicateMessage: string;
  duplicates: { count: number }[];
  totals: ReturnType<typeof sumMetrics>;
  rows: PreviewRow[];
};
type Manual = {
  periodStart: string;
  periodEnd: string;
  platform: string;
  storeName: string;
  campaign: string;
  spend: string;
  impressions: string;
  clicks: string;
  orders: string;
  adsRevenue: string;
};

const EMPTY_MANUAL: Manual = {
  periodStart: "",
  periodEnd: "",
  platform: "Lazada Ads",
  storeName: "",
  campaign: "",
  spend: "",
  impressions: "",
  clicks: "",
  orders: "",
  adsRevenue: "",
};

function platformClass(platform: string): string {
  if (platform === "Shopee Ads") return "plat shopee";
  if (platform === "TikTok Ads") return "plat tiktok";
  if (platform === "Meta Ads") return "plat meta";
  if (platform === "CPAS") return "plat cpas";
  if (platform === "Lazada Ads") return "plat lazada";
  if (platform === "Blibli Ads") return "plat blibli";
  return "plat lain";
}

function sourceLabel(source: SpendSource): string {
  if (source === "manual") return "Manual";
  if (source === "template") return "Template";
  return "File";
}

function monthChoices(selected: string): string[] {
  const [year, month] = wibMonth().split("-").map(Number);
  const list = Array.from({ length: 18 }, (_, index) => {
    const stamp = new Date(Date.UTC(year, month - 1 - index, 1));
    return stamp.toISOString().slice(0, 7);
  });
  if (!list.includes(selected)) list.unshift(selected);
  return list;
}

function useColumns() {
  const [keys, setKeys] = useState<ColumnKey[]>(COLUMNS.map((column) => column.key));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("marketing:columns") || "null") as unknown;
      if (!Array.isArray(saved)) return;
      const known = COLUMNS.map((column) => column.key).filter((key) => saved.includes(key));
      if (known.length) setKeys(known);
    } catch {
      // Keep the default columns, including the computed metrics.
    }
  }, []);
  function toggle(key: ColumnKey) {
    setKeys((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      const ordered = COLUMNS.map((column) => column.key).filter((item) => next.includes(item));
      if (!ordered.length) return current;
      window.localStorage.setItem("marketing:columns", JSON.stringify(ordered));
      return ordered;
    });
  }
  return { keys, open, setOpen, toggle, show: (key: ColumnKey) => keys.includes(key) };
}

async function saveBlob(response: Response, fallback: string) {
  if (response.status === 401) {
    window.location.href = "/masuk";
    throw new Error("Sesi habis.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Gagal mengunduh." }));
    throw new Error(body.error || "Gagal mengunduh.");
  }
  const blob = await response.blob();
  const named = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = named?.[1] || fallback;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function MetricCells({ row, show }: { row: { spend: number; impressions: number | null; clicks: number | null; orders: number | null; adsRevenue: number | null }; show: (key: ColumnKey) => boolean }) {
  const metrics = metricsOf(row);
  return (
    <>
      {show("spend") ? <td className="n">{rp(row.spend)}</td> : null}
      {show("impresi") ? <td className="n">{formatCount(row.impressions)}</td> : null}
      {show("klik") ? <td className="n">{formatCount(row.clicks)}</td> : null}
      {show("pesanan") ? <td className="n">{formatCount(row.orders)}</td> : null}
      {show("omzet") ? <td className="n">{row.adsRevenue == null ? "—" : rp(row.adsRevenue)}</td> : null}
      {show("ctr") ? <td className="n" title="Klik / impresi">{formatPct(metrics.ctr)}</td> : null}
      {show("cpc") ? <td className="n" title="Spend / klik">{metrics.cpc == null ? "—" : rp(metrics.cpc)}</td> : null}
      {show("cpm") ? <td className="n" title="Spend / impresi × 1000">{metrics.cpm == null ? "—" : rp(metrics.cpm)}</td> : null}
      {show("cvr") ? <td className="n" title="Pesanan / klik">{formatPct(metrics.cvr)}</td> : null}
      {show("cpo") ? <td className="n" title="Spend / pesanan">{metrics.cpo == null ? "—" : rp(metrics.cpo)}</td> : null}
      {show("roas") ? <td className="n" title="Omzet iklan / spend">{formatRatio(metrics.roas)}</td> : null}
      {show("acos") ? <td className="n" title="Spend / omzet iklan">{formatPct(metrics.acos)}</td> : null}
    </>
  );
}

export function MarketingView() {
  const [month, setMonth] = useState(wibMonth());
  const [status, setStatus] = useState<"active" | "deleted" | "all">("active");
  const [storeFilter, setStoreFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MarketingRecord[]>([]);
  const [stores, setStores] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState<Manual>(EMPTY_MANUAL);
  const [manualConflict, setManualConflict] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState("Shopee Ads");
  const [uploadStore, setUploadStore] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const columns = useColumns();

  async function load(nextMonth = month, nextStatus = status) {
    setLoading(true);
    try {
      const result = await api<{ rows: MarketingRecord[]; stores: string[] }>(`/api/marketing?month=${nextMonth}&status=${nextStatus}`);
      setRows(result.rows);
      setStores(result.stores);
      setError(null);
    } catch (err) {
      setError(reported(err, "Gagal memuat marketing spending."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // The first paint loads the current month.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => filterMarketingRows(rows, { store: storeFilter, platform: platformFilter, source: sourceFilter, q }), [rows, storeFilter, platformFilter, sourceFilter, q]);
  const page = useClientPage(filtered, "marketing-spend", 25);
  const cards = useMemo(() => {
    const map = new Map<string, MarketingRecord[]>();
    for (const row of rows) map.set(row.storeName, [...(map.get(row.storeName) ?? []), row]);
    return [...map.entries()].map(([storeName, items]) => ({
      storeName,
      spend: items.reduce((sum, row) => sum + row.spend, 0),
      count: items.length,
      platforms: [...new Set(items.map((row) => row.platform))],
    })).sort((a, b) => b.spend - a.spend);
  }, [rows]);
  const summary = useMemo(() => {
    const map = new Map<string, MarketingRecord[]>();
    for (const row of filtered) map.set(`${row.storeName}\u0000${row.platform}`, [...(map.get(`${row.storeName}\u0000${row.platform}`) ?? []), row]);
    const groups = [...map.entries()].map(([key, items]) => {
      const [storeName, platformName] = key.split("\u0000");
      const totals = sumMetrics(items);
      return { storeName, platform: platformName, count: items.length, totals, metrics: metricsOf(totals) };
    }).sort((a, b) => b.totals.spend - a.totals.spend);
    const totals = sumMetrics(filtered);
    return { groups, totals, metrics: metricsOf(totals), spend: totals.spend };
  }, [filtered]);
  const selectedIds = filtered.filter((row) => picked.includes(row.id) && !row.deletedAt).map((row) => row.id);
  const pageIds = page.shown.filter((row) => !row.deletedAt).map((row) => row.id);

  function resetUpload() {
    setUploadOpen(false);
    setStep(1);
    setFile(null);
    setPreview(null);
  }

  async function requestPreview(nextFile: File, nextPlatform: string, nextStore: string) {
    const form = new FormData();
    form.set("file", nextFile);
    form.set("platform", nextPlatform);
    if (nextStore) form.set("store", nextStore);
    return api<Preview>("/api/marketing/preview", { method: "POST", body: form });
  }

  async function chooseFile(next: File) {
    setFile(next);
    setPreview(null);
    setStep(1);
    const remembered = window.localStorage.getItem(`marketing:store:${platform}`) ?? "";
    const initial = uploadStore || (stores.includes(remembered) ? remembered : "");
    if (!uploadStore && initial) setUploadStore(initial);
    try {
      const result = await requestPreview(next, platform, initial);
      setPreview(result);
      if (!initial && result.storeMatch) setUploadStore(result.storeMatch);
    } catch (err) {
      reported(err, "Gagal membaca laporan.");
    }
  }

  async function lanjut() {
    if (!file) {
      reported(new Error("Pilih file laporan."), "Pilih file laporan.");
      return;
    }
    try {
      const result = await requestPreview(file, platform, uploadStore);
      setPreview(result);
      if (!uploadStore && result.storeMatch) setUploadStore(result.storeMatch);
      if (result.needsStore && !(uploadStore || result.storeMatch)) {
        reported(new Error("Pilih toko untuk semua baris dalam file ini."), "Pilih toko.");
        return;
      }
      setStep(2);
    } catch (err) {
      reported(err, "Gagal membaca laporan.");
    }
  }

  async function commit(overwrite: boolean) {
    if (!file) return;
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("platform", platform);
      if (uploadStore) form.set("store", uploadStore);
      form.set("overwrite", overwrite ? "1" : "0");
      const response = await track(fetch("/api/marketing/commit", { method: "POST", body: form }));
      const body = await response.json().catch(() => ({ error: "Gagal menyimpan." }));
      if (response.status === 401) {
        window.location.href = "/masuk";
        return;
      }
      if (response.status === 409) {
        setPreview((current) => current ? { ...current, duplicateMessage: body.error, duplicates: body.duplicates ?? current.duplicates } : current);
        reported(new Error(body.error || "Data duplikat."), "Data duplikat.");
        return;
      }
      if (!response.ok) throw new Error(body.error || "Gagal menyimpan.");
      if (uploadStore) window.localStorage.setItem(`marketing:store:${platform}`, uploadStore);
      reportedOk(overwrite ? `${body.inserted} baris disimpan. ${body.replaced} baris lama ditimpa.` : `${body.inserted} baris disimpan.`);
      resetUpload();
      await load();
    } catch (err) {
      reported(err, "Gagal menyimpan.");
    }
  }

  async function saveManual(overwrite: boolean) {
    try {
      const response = await track(fetch("/api/marketing/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...manual, overwrite }),
      }));
      const body = await response.json().catch(() => ({ error: "Gagal menyimpan." }));
      if (response.status === 401) {
        window.location.href = "/masuk";
        return;
      }
      if (response.status === 409) {
        setManualConflict(body.error || "Data duplikat.");
        return;
      }
      if (!response.ok) throw new Error(body.error || "Gagal menyimpan.");
      reportedOk(overwrite ? "Spending ditimpa." : "Spending disimpan.");
      setManualOpen(false);
      setManualConflict("");
      setManual(EMPTY_MANUAL);
      await load();
    } catch (err) {
      reported(err, "Gagal menyimpan.");
    }
  }

  async function removeSelected() {
    try {
      const result = await api<{ removed: number }>("/api/marketing", { method: "DELETE", body: JSON.stringify({ ids: selectedIds }) });
      reportedOk(`${result.removed} baris dihapus.`);
      setPicked([]);
      setConfirmDelete(false);
      await load();
    } catch (err) {
      reported(err, "Gagal menghapus.");
    }
  }

  async function download(format: "xlsx" | "csv") {
    const params = new URLSearchParams({ month, status, format, store: storeFilter, platform: platformFilter, source: sourceFilter, q });
    const response = await track(fetch(`/api/marketing/export?${params}`));
    await saveBlob(response, `marketing-spending-${month}.${format}`);
    reportedOk("Ekspor selesai.");
    setExportOpen(false);
  }

  const manualCross = Boolean(manual.periodStart && manual.periodEnd && !sameCalendarMonth(manual.periodStart, manual.periodEnd));
  const visibleCount = columns.keys.length;

  return (
    <div>
      {error ? <div className="warnbox" style={{ marginBottom: 12 }}>{error}</div> : null}
      <div className="pagehead">
        <div className="desc">Upload laporan iklan mingguan, atau input manual / template Excel untuk platform lain. Spend disimpan apa adanya dari report (tanpa PPN tambahan). Periode wajib dalam bulan yang sama.</div>
        <div className="actions">
          <button className="btn pri" onClick={() => { setManual(EMPTY_MANUAL); setManualConflict(""); setManualOpen(true); }}>+ Tambah</button>
          <button className="btn" onClick={() => { setUploadOpen(true); setStep(1); setFile(null); setPreview(null); }}>Upload laporan</button>
          <button className="btn" onClick={() => setTemplateOpen(true)}>Template Excel</button>
          <button className="btn danger" disabled={!selectedIds.length} onClick={() => setConfirmDelete(true)}>Hapus massal{selectedIds.length ? ` (${selectedIds.length})` : ""}</button>
          <div style={{ position: "relative" }}>
            <button className="btn" onClick={() => setExportOpen((value) => !value)}>Export</button>
            {exportOpen ? (
              <div className="colpop" style={{ width: 140 }}>
                <button className="btn" style={{ width: "100%", marginBottom: 6 }} onClick={() => download("xlsx").catch((err: Error) => reported(err, "Ekspor gagal."))}>Excel</button>
                <button className="btn" style={{ width: "100%" }} onClick={() => download("csv").catch((err: Error) => reported(err, "Ekspor gagal."))}>CSV</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="filterbar">
        <div className="f"><label>Bulan</label>
          <select aria-label="Bulan" value={month} onChange={(event) => { setMonth(event.target.value); setPicked([]); page.setPage(0); load(event.target.value, status).catch(() => undefined); }}>
            {monthChoices(month).map((item) => <option key={item} value={item}>{monthLabel(item)}</option>)}
          </select>
        </div>
        <div className="f"><label>Toko</label>
          <select aria-label="Toko" value={storeFilter} onChange={(event) => { setStoreFilter(event.target.value); page.setPage(0); }}>
            <option value="">Semua toko</option>
            {stores.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>Platform</label>
          <select aria-label="Platform" value={platformFilter} onChange={(event) => { setPlatformFilter(event.target.value); page.setPage(0); }}>
            <option value="">Semua platform</option>
            {PLATFORMS.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>Sumber</label>
          <select aria-label="Sumber" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); page.setPage(0); }}>
            <option value="">Semua sumber</option>
            <option value="file">File</option>
            <option value="manual">Manual</option>
            <option value="template">Template</option>
          </select>
        </div>
        <div className="f"><label>Cari</label>
          <input aria-label="Cari" value={q} placeholder="Nama kampanye / iklan..." onChange={(event) => { setQ(event.target.value); page.setPage(0); }} />
        </div>
        <div className="f"><label>Status data</label>
          <select aria-label="Status data" value={status} onChange={(event) => { const value = event.target.value as "active" | "deleted" | "all"; setStatus(value); setPicked([]); page.setPage(0); load(month, value).catch(() => undefined); }}>
            <option value="active">Aktif</option>
            <option value="deleted">Dihapus</option>
            <option value="all">Semua</option>
          </select>
        </div>
        <div className="f"><label>&nbsp;</label><button className="btn ghost" onClick={() => { setStoreFilter(""); setPlatformFilter(""); setSourceFilter(""); setQ(""); setStatus("active"); const current = wibMonth(); setMonth(current); page.setPage(0); load(current, "active").catch(() => undefined); }}>Reset filter</button></div>
      </div>
      <div className="g5">
        <button className={`card kpi ${storeFilter ? "" : "pick"}`} onClick={() => setStoreFilter("")}>
          <div className="l">Total spending · {monthLabel(month)}</div>
          <div className="v">{rpCompact(rows.reduce((sum, row) => sum + row.spend, 0))}</div>
          <div className="s">{rows.length} baris · {cards.length} toko</div>
        </button>
        {cards.map((card) => (
          <button key={card.storeName} className={`card kpi ${storeFilter === card.storeName ? "pick" : ""}`} onClick={() => setStoreFilter(card.storeName)}>
            <div className="l">{card.storeName}</div>
            <div className="v">{rpCompact(card.spend)}</div>
            <div className="s">{card.platforms.join(", ")} · {card.count} baris</div>
          </button>
        ))}
      </div>
      <div className="tablecard mt">
        <div className="th3"><b>Ringkasan per toko</b> <span className="small mut">metrik dihitung dari jumlah, bukan rata-rata rasio</span></div>
        <div className="tscroll"><table className="small">
          <thead><tr><th>Toko</th><th>Platform</th><th className="n">Baris</th><th className="n">Spend</th><th className="n">Porsi</th><th className="n">CTR</th><th className="n">CPC</th><th className="n">CPM</th><th className="n">CVR</th><th className="n">CPO</th><th className="n">ROAS</th><th className="n">ACOS</th></tr></thead>
          <tbody>
            {summary.groups.map((group) => {
              const share = summary.spend ? group.totals.spend / summary.spend * 100 : 0;
              return (
                <tr key={`${group.storeName}-${group.platform}`}>
                  <td>{group.storeName}</td>
                  <td><span className={platformClass(group.platform)}>{group.platform}</span></td>
                  <td className="n">{group.count}</td>
                  <td className="n">{rp(group.totals.spend)}</td>
                  <td className="n"><div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}><span>{share.toFixed(1).replace(".", ",")}%</span><span className="bar-in" style={{ width: 72 }}><i style={{ width: `${Math.max(2, share)}%` }} /></span></div></td>
                  <td className="n">{formatPct(group.metrics.ctr)}</td>
                  <td className="n">{group.metrics.cpc == null ? "—" : rp(group.metrics.cpc)}</td>
                  <td className="n">{group.metrics.cpm == null ? "—" : rp(group.metrics.cpm)}</td>
                  <td className="n">{formatPct(group.metrics.cvr)}</td>
                  <td className="n">{group.metrics.cpo == null ? "—" : rp(group.metrics.cpo)}</td>
                  <td className="n">{formatRatio(group.metrics.roas)}</td>
                  <td className="n">{formatPct(group.metrics.acos)}</td>
                </tr>
              );
            })}
            {summary.groups.length ? (
              <tr>
                <td colSpan={2}><b>Total</b></td>
                <td className="n"><b>{filtered.length}</b></td>
                <td className="n"><b>{rp(summary.totals.spend)}</b></td>
                <td className="n">100%</td>
                <td className="n">{formatPct(summary.metrics.ctr)}</td>
                <td className="n">{summary.metrics.cpc == null ? "—" : rp(summary.metrics.cpc)}</td>
                <td className="n">{summary.metrics.cpm == null ? "—" : rp(summary.metrics.cpm)}</td>
                <td className="n">{formatPct(summary.metrics.cvr)}</td>
                <td className="n">{summary.metrics.cpo == null ? "—" : rp(summary.metrics.cpo)}</td>
                <td className="n">{formatRatio(summary.metrics.roas)}</td>
                <td className="n">{formatPct(summary.metrics.acos)}</td>
              </tr>
            ) : <tr><td colSpan={12} className="mut">Belum ada spending di bulan ini.</td></tr>}
          </tbody>
        </table></div>
      </div>
      <TableShell loading={loading} className="tablecard mt">
        <div className="th3">
          <b>Rincian</b>
          <div style={{ position: "relative", marginLeft: "auto" }}>
            <button className="btn sm" aria-expanded={columns.open} onClick={() => columns.setOpen((value) => !value)}>Tampilkan kolom</button>
            {columns.open ? (
              <>
                <button className="ms-backdrop" aria-label="Tutup pemilih kolom" onClick={() => columns.setOpen(false)} />
                <div className="colpop">
                  <div className="small mut" style={{ padding: "4px 6px" }}>Kolom</div>
                  {COLUMNS.filter((column) => !column.metric).map((column) => (
                    <label key={column.key}><input type="checkbox" checked={columns.show(column.key)} onChange={() => columns.toggle(column.key)} />{column.label}</label>
                  ))}
                  <div className="small mut" style={{ padding: "8px 6px 4px" }}>Metrik hitung</div>
                  {COLUMNS.filter((column) => column.metric).map((column) => (
                    <label key={column.key}><input type="checkbox" checked={columns.show(column.key)} onChange={() => columns.toggle(column.key)} />{column.label}</label>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
        <div className="tscroll"><table className="small">
          <thead><tr>
            <th><input type="checkbox" aria-label="Pilih semua di halaman" checked={pageIds.length > 0 && pageIds.every((id) => picked.includes(id))} onChange={(event) => setPicked((current) => event.target.checked ? [...new Set([...current, ...pageIds])] : current.filter((id) => !pageIds.includes(id)))} /></th>
            {columns.show("periode") ? <th>Periode</th> : null}
            {columns.show("platform") ? <th>Platform</th> : null}
            {columns.show("toko") ? <th>Toko</th> : null}
            {columns.show("kampanye") ? <th>Nama kampanye / iklan</th> : null}
            {columns.show("spend") ? <th className="n">Spend</th> : null}
            {columns.show("impresi") ? <th className="n">Impresi</th> : null}
            {columns.show("klik") ? <th className="n">Klik</th> : null}
            {columns.show("pesanan") ? <th className="n">Pesanan iklan</th> : null}
            {columns.show("omzet") ? <th className="n">Omzet iklan</th> : null}
            {columns.show("ctr") ? <th className="n">CTR</th> : null}
            {columns.show("cpc") ? <th className="n">CPC</th> : null}
            {columns.show("cpm") ? <th className="n">CPM</th> : null}
            {columns.show("cvr") ? <th className="n">CVR</th> : null}
            {columns.show("cpo") ? <th className="n">CPO</th> : null}
            {columns.show("roas") ? <th className="n">ROAS</th> : null}
            {columns.show("acos") ? <th className="n">ACOS</th> : null}
            {columns.show("sumber") ? <th>Sumber</th> : null}
            {columns.show("diinput") ? <th>Diinput</th> : null}
            {columns.show("status") ? <th>Status data</th> : null}
          </tr></thead>
          <tbody>
            {page.shown.map((row) => (
              <tr key={row.id} className={row.deletedAt ? "deleted" : picked.includes(row.id) ? "sel" : ""}>
                <td><input type="checkbox" aria-label={`Pilih ${row.campaign || row.platform}`} disabled={Boolean(row.deletedAt)} checked={picked.includes(row.id)} onChange={(event) => setPicked((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></td>
                {columns.show("periode") ? <td className="nowrap">{formatPeriod(row.periodStart, row.periodEnd)}</td> : null}
                {columns.show("platform") ? <td><span className={platformClass(row.platform)}>{row.platform}</span></td> : null}
                {columns.show("toko") ? <td>{row.storeName}</td> : null}
                {columns.show("kampanye") ? <td style={{ maxWidth: 280 }}>{row.campaign || "—"}</td> : null}
                <MetricCells row={row} show={columns.show} />
                {columns.show("sumber") ? <td><span className="pill p-info" title={row.sourceFile || sourceLabel(row.source)}>{sourceLabel(row.source)}</span></td> : null}
                {columns.show("diinput") ? <td className="small">{formatStampSafe(row.createdAt)}<div className="mut">{row.createdBy}</div></td> : null}
                {columns.show("status") ? <td>{row.deletedAt ? <span className="pill p-bad">Dihapus</span> : <span className="pill p-ok">Aktif</span>}</td> : null}
              </tr>
            ))}
            {!page.shown.length && !loading ? <tr><td colSpan={visibleCount + 1} className="mut">Tidak ada baris untuk filter ini.</td></tr> : null}
          </tbody>
        </table></div>
        <Pager page={page.page} pageSize={page.pageSize} total={page.total} shown={page.shown.length} onPage={page.setPage} onPageSize={page.setPageSize} />
      </TableShell>

      {uploadOpen ? <div className="modal-bg on"><div className="modal" style={{ width: step === 2 ? 920 : 680 }}>
        <h2>{step === 1 ? "Upload laporan iklan" : "Pratinjau upload"}</h2>
        <div className="small" style={{ marginBottom: 8 }}><b className={step === 1 ? "" : "mut"}>1. Pilih file</b> <span className="mut">→</span> <b className={step === 2 ? "" : "mut"}>2. Pratinjau</b> <span className="mut">→</span> <b className="mut">3. Simpan</b></div>
        {step === 1 ? (
          <>
            <p className="small mut">Unggah report mingguan dari Shopee Ads, TikTok Ads, Meta Ads, atau CPAS. Untuk Lazada, Blibli, dan lainnya, pakai template Excel standar.</p>
            <div className="f"><label>Platform iklan</label>
              <select aria-label="Platform iklan" value={platform} onChange={(event) => { setPlatform(event.target.value); setPreview(null); const remembered = window.localStorage.getItem(`marketing:store:${event.target.value}`) ?? ""; setUploadStore(stores.includes(remembered) ? remembered : ""); }}>
                {UPLOAD_PLATFORMS.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>
            <label className="drop mt">
              <input hidden type="file" accept=".csv,.xlsx,.xls" aria-label="File laporan" onChange={(event) => { const next = event.target.files?.[0]; event.target.value = ""; if (next) chooseFile(next).catch(() => undefined); }} />
              {file ? <><b>{file.name}</b><div className="small mut">Klik untuk ganti file</div></> : <><b>Pilih file laporan</b><div className="small mut">CSV atau Excel</div></>}
            </label>
            {["Shopee Ads", "TikTok Ads", "Meta Ads", "CPAS"].includes(platform) ? (
              <div className="f mt"><label>Toko{platform === "Shopee Ads" ? "" : " *"}</label>
                <select aria-label="Toko unggahan" value={uploadStore} onChange={(event) => setUploadStore(event.target.value)}>
                  <option value="">— Pilih toko —</option>
                  {stores.map((item) => <option key={item}>{item}</option>)}
                </select>
                <div className="small mut" style={{ marginTop: 4 }}>
                  {platform === "Shopee Ads" && preview?.storeRaw ? `Terdeteksi dari file: ${preview.storeRaw}${preview.storeMatch ? ` → dipetakan ke toko ${preview.storeMatch}` : ". Pilih toko jika pemetaan belum cocok"}.` : null}
                  {platform !== "Shopee Ads" ? `File ${platform} tidak memuat nama toko. Pilih satu toko yang berlaku untuk semua baris dalam file ini. Pilihan ini diingat untuk unggahan berikutnya.` : null}
                </div>
              </div>
            ) : <p className="small mut mt">Toko dan platform dibaca dari kolom template. Nama toko harus sama dengan daftar toko.</p>}
            <div className="note mt">Aturan periode: tanggal mulai dan selesai harus dalam bulan yang sama. File agregat (Shopee, Meta, CPAS) yang lintas bulan ditolak. Baris harian TikTok yang lintas bulan dipecah otomatis per bulan.</div>
            <div className="modal-actions">
              <button className="btn" onClick={resetUpload}>Batal</button>
              <ActionButton className="btn pri" onClick={lanjut}>Lanjut: Pratinjau</ActionButton>
            </div>
          </>
        ) : preview ? (
          <>
            <p className="small mut">Periksa baris hasil baca sebelum disimpan. Spend tidak ditambah PPN.</p>
            {preview.crossesMonth ? <div className="badbox"><b>Periode ditolak — lintas bulan</b><div style={{ marginTop: 6 }}>{preview.monthMessage}</div></div> : null}
            {!preview.crossesMonth && preview.duplicates.length ? (
              <div className="warnbox"><b>Data duplikat terdeteksi</b><div style={{ marginTop: 6 }}>{preview.duplicateMessage}</div></div>
            ) : null}
            {preview.note ? <div className="note" style={{ marginTop: 8 }}>{preview.note}</div> : null}
            {preview.unresolved.length && preview.kind === "template" ? <div className="warnbox" style={{ marginTop: 8 }}>Toko tidak dikenali: {preview.unresolved.join(", ")}. Samakan dengan daftar toko, lalu unggah lagi.</div> : null}
            {!preview.crossesMonth ? (
              <>
                <div className="kv">
                  <span>Platform</span><b><span className={platformClass(preview.platform)}>{preview.platform}</span></b>
                  <span>Toko</span><b>{uploadStore || preview.storeMatch || "—"}</b>
                  <span>Periode terdeteksi</span><b>{preview.periodLabel}</b>
                  <span>File</span><b>{preview.filename}</b>
                  <span>Baris terbaca</span><b>{preview.readCount}</b>
                  <span>Baris valid</span><b>{preview.validCount}</b>
                  <span>Dilewati</span><b style={{ color: preview.skipped.length ? "var(--warn)" : undefined }}>{preview.skipped.length ? `${preview.skipped.length} · ${[...new Set(preview.skipped.map((item) => item.reason))].join(", ")}` : "0"}</b>
                  <span>Total spend</span><b>{rp(preview.totals.spend)}</b>
                  <span>Impresi / klik</span><b>{formatCount(preview.totals.impressions)} / {formatCount(preview.totals.clicks)}</b>
                  <span>Pesanan / omzet iklan</span><b>{formatCount(preview.totals.orders)} / {preview.totals.adsRevenue == null ? "—" : rp(preview.totals.adsRevenue)}</b>
                </div>
                <div className="tscroll" style={{ maxHeight: 280 }}><table className="small">
                  <thead><tr><th>Periode</th><th>Nama kampanye / iklan</th><th className="n">Spend</th><th className="n">Impresi</th><th className="n">Klik</th><th className="n">Pesanan</th><th className="n">Omzet iklan</th></tr></thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={`${row.lineNo}-${row.campaign}`}>
                        <td className="nowrap">{row.periodLabel}</td>
                        <td>{row.campaign || "—"}</td>
                        <td className="n">{rp(row.spend)}</td>
                        <td className="n">{formatCount(row.impressions)}</td>
                        <td className="n">{formatCount(row.clicks)}</td>
                        <td className="n">{formatCount(row.orders)}</td>
                        <td className="n">{row.adsRevenue == null ? "—" : rp(row.adsRevenue)}</td>
                      </tr>
                    ))}
                    <tr><td colSpan={2}><b>Total</b></td><td className="n"><b>{rp(preview.totals.spend)}</b></td><td className="n">{formatCount(preview.totals.impressions)}</td><td className="n">{formatCount(preview.totals.clicks)}</td><td className="n">{formatCount(preview.totals.orders)}</td><td className="n">{preview.totals.adsRevenue == null ? "—" : rp(preview.totals.adsRevenue)}</td></tr>
                  </tbody>
                </table></div>
              </>
            ) : null}
            <div className="modal-actions">
              <button className="btn" onClick={() => setStep(1)}>← Kembali</button>
              {preview.crossesMonth ? <button className="btn" onClick={resetUpload}>Tutup</button> : null}
              {!preview.crossesMonth && preview.duplicates.length ? <button className="btn" onClick={resetUpload}>Batal</button> : null}
              {!preview.crossesMonth && preview.duplicates.length ? <ActionButton className="btn bad" onClick={() => commit(true)}>Timpa data lama</ActionButton> : null}
              {!preview.crossesMonth && !preview.duplicates.length && preview.validCount > 0 && !preview.unresolved.length ? <ActionButton className="btn pri" onClick={() => commit(false)}>Simpan {preview.validCount} baris</ActionButton> : null}
            </div>
          </>
        ) : <div className="note"><Spinner /> Memuat pratinjau…</div>}
      </div></div> : null}

      {manualOpen ? <div className="modal-bg on"><div className="modal">
        <h2>Tambah spending</h2>
        <p className="small mut">Input manual untuk platform yang tidak punya report (Lazada, Blibli, dan lainnya), atau koreksi satu baris.</p>
        <div className="grid g2">
          <div className="f"><label>Tanggal mulai</label><input type="date" value={manual.periodStart} onChange={(event) => setManual({ ...manual, periodStart: event.target.value })} /></div>
          <div className="f"><label>Tanggal selesai</label><input type="date" value={manual.periodEnd} onChange={(event) => setManual({ ...manual, periodEnd: event.target.value })} /></div>
        </div>
        <div className="grid g2 mt">
          <div className="f"><label>Platform iklan</label>
            <select aria-label="Platform manual" value={manual.platform} onChange={(event) => setManual({ ...manual, platform: event.target.value })}>
              {PLATFORMS.map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>
          <div className="f"><label>Toko</label>
            <select aria-label="Toko manual" value={manual.storeName} onChange={(event) => setManual({ ...manual, storeName: event.target.value })}>
              <option value="">— Pilih toko —</option>
              {stores.map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>
        </div>
        <div className="f mt"><label>Nama kampanye / iklan (opsional)</label><input value={manual.campaign} onChange={(event) => setManual({ ...manual, campaign: event.target.value })} /></div>
        <div className="grid g2 mt">
          <div className="f"><label>Spend (Rp)</label><input inputMode="decimal" placeholder="Mis. 250000" value={manual.spend} onChange={(event) => setManual({ ...manual, spend: event.target.value })} /></div>
          <div className="f"><label>Impresi (opsional)</label><input inputMode="numeric" value={manual.impressions} onChange={(event) => setManual({ ...manual, impressions: event.target.value })} /></div>
          <div className="f"><label>Klik (opsional)</label><input inputMode="numeric" value={manual.clicks} onChange={(event) => setManual({ ...manual, clicks: event.target.value })} /></div>
          <div className="f"><label>Pesanan dari iklan (opsional)</label><input inputMode="numeric" value={manual.orders} onChange={(event) => setManual({ ...manual, orders: event.target.value })} /></div>
        </div>
        <div className="f mt"><label>Omzet dari iklan (Rp) (opsional)</label><input inputMode="decimal" value={manual.adsRevenue} onChange={(event) => setManual({ ...manual, adsRevenue: event.target.value })} /></div>
        {manualCross ? <div className="badbox mt">Tanggal mulai dan selesai harus dalam bulan yang sama.</div> : <div className="note mt">Tanggal mulai dan selesai harus dalam bulan yang sama. Spend diisi apa adanya (tidak ditambah PPN). Sumber akan tercatat sebagai Manual.</div>}
        {manualConflict ? <div className="warnbox mt">{manualConflict}</div> : null}
        <div className="modal-actions">
          <button className="btn" onClick={() => { setManualOpen(false); setManualConflict(""); }}>Batal</button>
          {manualConflict ? <ActionButton className="btn bad" onClick={() => saveManual(true)}>Timpa data lama</ActionButton> : <ActionButton className="btn pri" disabled={manualCross || !manual.periodStart || !manual.periodEnd || !manual.storeName || !manual.spend} onClick={() => saveManual(false)}>Simpan</ActionButton>}
        </div>
      </div></div> : null}

      {templateOpen ? <div className="modal-bg on"><div className="modal" style={{ width: 760 }}>
        <h2>Template Excel standar</h2>
        <p className="small mut">Pakai template ini untuk Lazada Ads, Blibli Ads, dan spending lain yang tidak punya report otomatis. Satu baris = satu biaya iklan. Unduh, isi, lalu unggah lewat tombol Upload laporan (pilih platform sesuai, atau Template Excel).</p>
        <div className="tscroll" style={{ maxHeight: 320 }}><table className="small">
          <thead><tr><th>Kolom</th><th>Wajib</th><th>Keterangan</th></tr></thead>
          <tbody>
            <tr><td>tanggal_mulai</td><td>Ya</td><td>Format hh/bb/tttt, misalnya 09/11/2026</td></tr>
            <tr><td>tanggal_selesai</td><td>Ya</td><td>Harus dalam bulan yang sama dengan tanggal_mulai</td></tr>
            <tr><td>platform</td><td>Ya</td><td>{PLATFORMS.join(", ")}</td></tr>
            <tr><td>toko</td><td>Ya</td><td>Nama toko harus sama dengan daftar toko di aplikasi</td></tr>
            <tr><td>nama_kampanye</td><td>Tidak</td><td>Nama kampanye atau iklan</td></tr>
            <tr><td>spend</td><td>Ya</td><td>Biaya iklan dalam Rupiah, apa adanya dari report (jangan tambah PPN)</td></tr>
            <tr><td>impresi</td><td>Tidak</td><td>Jumlah tayangan</td></tr>
            <tr><td>klik</td><td>Tidak</td><td>Jumlah klik</td></tr>
            <tr><td>pesanan_iklan</td><td>Tidak</td><td>Pesanan / konversi yang berasal dari iklan</td></tr>
            <tr><td>omzet_iklan</td><td>Tidak</td><td>Omzet (Rp) yang berasal dari iklan</td></tr>
          </tbody>
        </table></div>
        <div className="note mt">
          <ul className="rules">
            <li>Semua baris dalam satu file sebaiknya satu bulan yang sama. Baris yang lintas bulan ditolak.</li>
            <li>Jika platform + toko + tanggalnya bertumpuk dengan data yang sudah ada, sistem menampilkan peringatan Timpa atau Batal.</li>
            <li>Sumber akan tercatat sebagai nama file. Untuk satu baris saja, lebih praktis pakai tombol Tambah (sumber: Manual).</li>
          </ul>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setTemplateOpen(false)}>Tutup</button>
          <ActionButton className="btn pri" onClick={async () => { const response = await track(fetch("/api/marketing/template")); await saveBlob(response, "template-marketing-spending.xlsx"); reportedOk("Template diunduh."); }}>Unduh template.xlsx</ActionButton>
        </div>
      </div></div> : null}

      {confirmDelete ? <div className="modal-bg on"><div className="modal">
        <h2>Hapus massal</h2>
        <p>Hapus {selectedIds.length} baris marketing spending? Data tidak dihapus permanen. Baris lama tetap ada di audit dan bisa dilihat lewat status Dihapus.</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirmDelete(false)}>Batal</button>
          <ActionButton className="btn bad" onClick={removeSelected}>Hapus</ActionButton>
        </div>
      </div></div> : null}
    </div>
  );
}

function formatStampSafe(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", day: "numeric", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${Number(pick("day"))} ${months[Number(pick("month")) - 1] ?? ""} ${pick("year")} ${pick("hour")}.${pick("minute")}`;
}
