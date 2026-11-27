"use client";

import { useEffect, useState } from "react";
import { ActionButton, reported, reportedOk, TableShell } from "@/components/ui/feedback";
import { Pager, usePageSize } from "@/components/ui/pager";
import { api, track } from "@/lib/api-client";
import { rp } from "@/lib/format";

type Kind = "affiliate" | "group" | "sku";
type Row = {
  noPesanan?: string;
  day?: string;
  channel?: string;
  storeName?: string;
  feeGroup?: string;
  feeName?: string;
  sku?: string;
  amount?: number;
  orders?: number;
};
type Page = { total: number; page: number; pages: number; rows: Row[] };

const TITLE: Record<Kind, string> = {
  affiliate: "Komisi afiliasi per pesanan",
  group: "Biaya per grup",
  sku: "Biaya per SKU",
};

async function saveBlob(response: Response, filename: string) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Gagal mengunduh." }));
    throw new Error(payload.error || "Gagal mengunduh.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function FeeReports() {
  const [kind, setKind] = useState<Kind>("group");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [channel, setChannel] = useState("");
  const [storeName, setStoreName] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [stores, setStores] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize, ready] = usePageSize("fee-report", 25);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  function query(nextPage = page, nextKind = kind, nextFrom = from, nextTo = to, nextChannel = channel, nextStore = storeName, nextLimit = pageSize) {
    const params = new URLSearchParams({ kind: nextKind, page: String(nextPage), limit: String(nextLimit) });
    if (nextFrom) params.set("from", nextFrom);
    if (nextTo) params.set("to", nextTo);
    if (nextChannel) params.set("channels", nextChannel);
    if (nextStore) params.set("stores", nextStore);
    return params.toString();
  }

  async function load(nextPage = page, nextKind = kind, nextFrom = from, nextTo = to, nextChannel = channel, nextStore = storeName, nextLimit = pageSize) {
    setLoading(true);
    try {
      setData(await api<Page>(`/api/fees/report?${query(nextPage, nextKind, nextFrom, nextTo, nextChannel, nextStore, nextLimit)}`));
      setError(null);
    } catch (err) {
      setError(reported(err, "Gagal memuat laporan biaya."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api<{ options?: { channels?: string[]; stores?: string[] } }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query: { granularity: "day" }, includeOptions: true }),
    }).then((result) => {
      setChannels(result.options?.channels ?? []);
      setStores(result.options?.stores ?? []);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!ready) return;
    load(0, kind, from, to, channel, storeName, pageSize).catch(() => undefined);
    // The filter state is read on each ready/pageSize change; later changes call load directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function download(format: "xlsx" | "pdf") {
    const response = await track(fetch(`/api/fees/export?${query(0)}&format=${format}`));
    await saveBlob(response, `biaya-${kind}.${format}`);
    reportedOk(format === "pdf" ? "PDF diunduh." : "Excel diunduh.");
  }

  const rows = data?.rows ?? [];

  return (
    <div className="card mt">
      <h3>Laporan biaya</h3>
      <div className="filterbar">
        <div className="f"><label>Laporan</label>
          <select aria-label="Jenis laporan biaya" value={kind} onChange={(event) => { const next = event.target.value as Kind; setKind(next); setPage(0); load(0, next).catch(() => undefined); }}>
            {(Object.keys(TITLE) as Kind[]).map((item) => <option key={item} value={item}>{TITLE[item]}</option>)}
          </select>
        </div>
        <div className="f"><label>Dari</label><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(0); load(0, kind, event.target.value, to).catch(() => undefined); }} /></div>
        <div className="f"><label>Sampai</label><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(0); load(0, kind, from, event.target.value).catch(() => undefined); }} /></div>
        <div className="f"><label>Channel</label>
          <select value={channel} onChange={(event) => { setChannel(event.target.value); setPage(0); load(0, kind, from, to, event.target.value, storeName).catch(() => undefined); }}>
            <option value="">Semua</option>
            {channels.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>Toko</label>
          <select value={storeName} onChange={(event) => { setStoreName(event.target.value); setPage(0); load(0, kind, from, to, channel, event.target.value).catch(() => undefined); }}>
            <option value="">Semua</option>
            {stores.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>&nbsp;</label><ActionButton className="btn" onClick={() => download("xlsx")}>Excel</ActionButton></div>
        <div className="f"><label>&nbsp;</label><ActionButton className="btn" onClick={() => download("pdf")}>PDF</ActionButton></div>
      </div>
      {error ? <div className="warnbox">{error}</div> : null}
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small cards">
            <thead>
              <tr>
                {kind === "affiliate" ? <th>No pesanan</th> : null}
                {kind === "affiliate" ? <th>Tanggal</th> : null}
                <th>Channel</th>
                <th>Toko</th>
                {kind === "group" ? <th>Grup</th> : null}
                {kind === "sku" ? <th>SKU</th> : null}
                {kind === "affiliate" ? <th>Nama</th> : null}
                {kind !== "affiliate" ? <th className="n">Pesanan</th> : null}
                <th className="n">Nominal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.noPesanan ?? ""}-${row.channel}-${row.storeName}-${row.feeGroup ?? row.sku ?? row.feeName}-${index}`}>
                  {kind === "affiliate" ? <td data-label="No pesanan">{row.noPesanan}</td> : null}
                  {kind === "affiliate" ? <td data-label="Tanggal">{row.day}</td> : null}
                  <td data-label="Channel">{row.channel}</td>
                  <td data-label="Toko">{row.storeName}</td>
                  {kind === "group" ? <td data-label="Grup">{row.feeGroup}</td> : null}
                  {kind === "sku" ? <td data-label="SKU">{row.sku}</td> : null}
                  {kind === "affiliate" ? <td data-label="Nama">{row.feeName}</td> : null}
                  {kind !== "affiliate" ? <td data-label="Pesanan" className="n">{row.orders ?? 0}</td> : null}
                  <td data-label="Nominal" className="n">{rp(Number(row.amount ?? 0))}</td>
                </tr>
              ))}
              {!rows.length && !loading ? <tr><td colSpan={7} className="mut">Tidak ada data</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager
          page={data?.page ?? page}
          pageSize={pageSize}
          total={data?.total ?? 0}
          shown={rows.length}
          onPage={(next) => { setPage(next); load(next).catch(() => undefined); }}
          onPageSize={(next) => { setPageSize(next); setPage(0); load(0, kind, from, to, channel, storeName, next).catch(() => undefined); }}
        />
      </TableShell>
    </div>
  );
}
