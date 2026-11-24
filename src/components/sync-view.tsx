"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionButton, reported, reportedOk, TableShell } from "@/components/ui/feedback";
import { Pager, useClientPage, usePageSize } from "@/components/ui/pager";
import { api } from "@/lib/api-client";
import type { AppMeta, SyncReviewRow } from "@/lib/db/types";
import type { SyncReviewPage } from "@/lib/db/store";
import { invoiceTotals } from "@/lib/accurate/invoice";
import { accurateIntent, SYNC_FAILED_REASON, syncReason } from "@/lib/domain/phase3";
import { rp } from "@/lib/format";

type LogRow = { at: string; actor: string | null; action: string; noPesanan: string; note: string };
type SyncMeta = AppMeta & { salesPush?: boolean; accurateDatabaseId?: string };
type QueueItem = { row: SyncReviewRow; intent: ReturnType<typeof accurateIntent>; why: string };

const REASONS = ["Belum pernah sync", "Gagal sync", "Data berubah", "Status jadi RETURNED", "Status jadi CANCELED"];
const ACTIONS = [
  "Buat penjualan",
  "Buat penjualan (Barang Hilang)",
  "Ubah penjualan",
  "Hapus penjualan",
  "Buat Retur penjualan",
  "Tidak diproses otomatis",
  "Tidak dikirim (cancel sebelum sync)",
  "Tidak dikirim (retur sebelum sync)",
];

function stamp(value?: string | null) {
  if (!value) return "—";
  return value.slice(0, 16).replace("T", " ");
}

function problem(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Permintaan gagal.";
}

function InvoicePreview({ rows }: { rows: { noPesanan: string; total: number }[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt">
      <div className="small"><b>Pratinjau faktur</b></div>
      <div className="small mut">Nomor faktur sama dengan nomor pesanan. Total sudah termasuk PPN 11%. Accurate memecah DPP dan PPN di dalam faktur, dan total faktur tetap sama dengan total pesanan.</div>
      <div className="tscroll" style={{ maxHeight: 200 }}>
        <table className="small">
          <thead><tr><th>No faktur</th><th className="n">Total termasuk PPN</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.noPesanan}>
                <td>{row.noPesanan}</td>
                <td className="n">{rp(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SyncView() {
  const [meta, setMeta] = useState<SyncMeta | null>(null);
  const [rows, setRows] = useState<SyncReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stores, setStores] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [store, setStore] = useState("");
  const [channel, setChannel] = useState("");
  const [reason, setReason] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize, hydrated] = usePageSize("sync-queue", 25);
  const [loading, setLoading] = useState(true);
  const [alias, setAlias] = useState("");
  const [selected, setSelected] = useState<Map<string, QueueItem>>(new Map());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(async (opts?: { keepError?: boolean }) => {
    const id = ++requestRef.current;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedQ) params.set("q", debouncedQ);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (store) params.set("store", store);
    if (channel) params.set("channel", channel);
    if (reason) params.set("reason", reason);
    if (action) params.set("action", action);
    try {
      const [metaResult, reviewResult, historyResult] = await Promise.allSettled([
        api<SyncMeta>("/api/meta"),
        api<SyncReviewPage>(`/api/sync/review?${params}`),
        api<{ log?: LogRow[] }>("/api/sync/history"),
      ]);
      if (id !== requestRef.current) return;
      if (metaResult.status === "fulfilled") setMeta(metaResult.value);
      if (historyResult.status === "fulfilled") setLog(historyResult.value.log ?? []);
      const ppn = metaResult.status === "fulfilled" ? metaResult.value.ppnReportDate || null : null;
      if (reviewResult.status === "fulfilled") {
        setRows(reviewResult.value.rows);
        setTotal(reviewResult.value.total);
        setStores(reviewResult.value.facets?.stores ?? []);
        setChannels(reviewResult.value.facets?.channels ?? []);
        const fresh = new Map(reviewResult.value.rows.map((row) => {
          const everSynced = Boolean(row.baseline || row.accurateNumber);
          const item: QueueItem = {
            row,
            intent: accurateIntent({
              status: row.current.status,
              everSynced,
              orderDay: row.day,
              ppnReportDate: ppn,
              lossSibling: Boolean(row.current.lossSibling),
            }),
            why: syncReason(row.category, everSynced, Boolean(row.lastSyncError)),
          };
          return [row.noPesanan, item] as const;
        }));
        setSelected((current) => {
          if (!current.size) return current;
          const next = new Map(current);
          for (const [no, item] of fresh) {
            if (next.has(no)) next.set(no, item);
          }
          return next;
        });
      } else {
        setRows([]);
        setTotal(0);
      }
      const problems = [
        reviewResult.status === "rejected" ? problem(reviewResult.reason) : "",
        metaResult.status === "rejected" ? problem(metaResult.reason) : "",
        historyResult.status === "rejected" ? problem(historyResult.reason) : "",
      ].filter(Boolean);
      if (problems.length) setError(problems.join(" "));
      else if (!opts?.keepError) setError(null);
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, [action, channel, debouncedQ, from, page, pageSize, reason, store, to]);

  useEffect(() => {
    if (!hydrated) return;
    load().catch((err: Error) => setError(err.message));
  }, [hydrated, load]);

  useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)) || 1);
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pageSize, total]);

  const ppn = meta?.ppnReportDate || null;
  const described = useMemo(() => rows.map((row) => {
    const everSynced = Boolean(row.baseline || row.accurateNumber);
    const intent = accurateIntent({
      status: row.current.status,
      everSynced,
      orderDay: row.day,
      ppnReportDate: ppn,
      lossSibling: Boolean(row.current.lossSibling),
    });
    return { row, intent, why: syncReason(row.category, everSynced, Boolean(row.lastSyncError)) };
  }), [rows, ppn]);

  const logPage = useClientPage(log, "sync-log", 50);
  const chosen = [...selected.values()];
  const syncable = chosen.filter((item) => !item.intent.block && !item.intent.label.startsWith("Tidak dikirim"));
  const salesPush = meta?.salesPush === true;
  const databaseId = meta?.accurateDatabaseId ?? "";
  const databaseLabel = alias && databaseId ? `${alias} (${databaseId})` : databaseId;
  useEffect(() => {
    if (!salesPush || !databaseId) return;
    api<{ databases: { id: string; alias: string }[] }>("/api/accurate/databases")
      .then((result) => setAlias(result.databases.find((item) => item.id === databaseId)?.alias ?? ""))
      .catch(() => setAlias(""));
  }, [salesPush, databaseId]);
  const last = log.find((entry) => entry.action === "sync" && !entry.note.startsWith("Pelanggan") && !entry.note.startsWith("Nama pembeli"));
  const lastLabel = last ? `${stamp(last.at)} oleh ${last.actor || "sistem"}` : "belum pernah";
  const pageNos = described.map((item) => item.row.noPesanan);
  const allOnPage = pageNos.length > 0 && pageNos.every((no) => selected.has(no));
  const storeOptions = store && !stores.includes(store) ? [store, ...stores] : stores;
  const channelOptions = channel && !channels.includes(channel) ? [channel, ...channels] : channels;

  function clearFilters() {
    setPage(0);
    setSelected(new Map());
  }

  function detailsFor(nos: string[]): QueueItem[] {
    const byNo = new Map(selected);
    for (const item of described) byNo.set(item.row.noPesanan, item);
    return nos.flatMap((no) => {
      const item = byNo.get(no);
      return item ? [item] : [];
    });
  }

  async function ignore(nos: string[]) {
    setBusy(true);
    setError(null);
    try {
      for (const noPesanan of nos) {
        await api("/api/sync/decision", { method: "POST", body: JSON.stringify({ noPesanan, decision: "ignored" }) });
      }
      setMessage(reportedOk(`${nos.length} pesanan diabaikan. Tgl Synced diisi dan pesanan keluar dari antrean.`));
      setSelected(new Map());
      setConfirm(null);
      await load();
    } catch (err) {
      setError(reported(err, "Gagal mengabaikan."));
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(nos: string[]) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/sync/execute", { method: "POST", body: JSON.stringify({ nos }) });
      setMessage(reportedOk("Sync selesai."));
      setConfirm(null);
      setSelected(new Map());
      await load();
    } catch (err) {
      setError(reported(err, "Sync gagal."));
      setConfirm(null);
      await load({ keepError: true }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function toggle(no: string, on: boolean) {
    const item = described.find((entry) => entry.row.noPesanan === no);
    setSelected((current) => {
      const next = new Map(current);
      if (on && item) next.set(no, item);
      else next.delete(no);
      return next;
    });
  }

  function togglePage(on: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      if (on) {
        for (const item of described) next.set(item.row.noPesanan, item);
      } else {
        for (const no of pageNos) next.delete(no);
      }
      return next;
    });
  }

  return (
    <div>
      <div className="pagehead">
        <div className="desc">Hanya pesanan yang <b>Tgl Updated lebih baru dari Tgl Synced</b> (atau belum pernah sync), dan bukan Dihapus. Setelah Sync atau Abaikan, pesanan hilang dari daftar. Tutup buku mengikuti tanggal lapor PPN terakhir{ppn ? <> (<b>{ppn}</b>)</> : null}.</div>
        <div className="actions">
          <span className="small mut">Terakhir sync: <b>{lastLabel}</b></span>
          <button className="btn pri" disabled={!syncable.length || busy} onClick={() => setConfirm(syncable.map((item) => item.row.noPesanan))}>Sync ke Accurate ({syncable.length})</button>
          <ActionButton className="btn" disabled={!chosen.length || busy} onClick={() => ignore(chosen.map((item) => item.row.noPesanan))}>Abaikan Sync ({chosen.length})</ActionButton>
          <button className="btn" onClick={() => setRulesOpen(true)}>Aturan Accurate</button>
        </div>
      </div>
      {error ? <div className="warnbox" style={{ marginBottom: 12 }}>{error}</div> : null}
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      {meta && salesPush && databaseId ? <div className="note" style={{ marginBottom: 12 }}>Pengiriman penjualan aktif. Sync mengirim data ke Accurate, database <b>{databaseLabel}</b>.</div> : null}
      {meta && salesPush && !databaseId ? <div className="warnbox" style={{ marginBottom: 12 }}>Pengiriman penjualan aktif, tetapi ID database Accurate kosong. Isi database di Koneksi Accurate sebelum sync.</div> : null}
      {meta && !salesPush ? <div className="warnbox" style={{ marginBottom: 12 }}>Pengiriman jual, cancel, dan retur ke Accurate tetap ditahan sampai <b>ACCURATE_SALES_PUSH=enabled</b>. Tombol Sync tidak mengirim data selama guard itu mati.</div> : null}
      <div className="filterbar">
        <div className="f grow"><label>Cari</label><input value={q} placeholder="No pesanan, pelanggan…" onChange={(event) => { setQ(event.target.value); clearFilters(); }} /></div>
        <div className="f"><label>Dari</label><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); clearFilters(); }} /></div>
        <div className="f"><label>Sampai</label><input type="date" value={to} onChange={(event) => { setTo(event.target.value); clearFilters(); }} /></div>
        <div className="f"><label>Toko</label><select value={store} onChange={(event) => { setStore(event.target.value); clearFilters(); }}><option value="">Semua</option>{storeOptions.map((item) => <option key={item}>{item}</option>)}</select></div>
        <div className="f"><label>Channel</label><select value={channel} onChange={(event) => { setChannel(event.target.value); clearFilters(); }}><option value="">Semua</option>{channelOptions.map((item) => <option key={item}>{item}</option>)}</select></div>
        <div className="f"><label>Alasan</label><select value={reason} onChange={(event) => { setReason(event.target.value); clearFilters(); }}><option value="">Semua</option>{REASONS.map((item) => <option key={item}>{item}</option>)}</select></div>
        <div className="f"><label>Tindakan di Accurate</label><select value={action} onChange={(event) => { setAction(event.target.value); clearFilters(); }}><option value="">Semua</option>{ACTIONS.map((item) => <option key={item}>{item}</option>)}</select></div>
      </div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="cards small">
            <thead><tr><th><input type="checkbox" aria-label="Pilih semua di halaman ini" checked={allOnPage} disabled={!pageNos.length} onChange={(event) => togglePage(event.target.checked)} /></th><th>No Pesanan</th><th>Tgl Pesanan</th><th>Toko</th><th>Channel</th><th>Status</th><th className="n">Revenue Bersih</th><th>Alasan</th><th>Tutup buku</th><th>Tindakan di Accurate</th><th>Tgl Updated</th><th>Tgl Synced</th><th></th></tr></thead>
            <tbody>
              {described.map(({ row, intent, why }) => {
                const closed = row.day && ppn ? row.day <= ppn : false;
                return (
                  <tr key={row.noPesanan} className={selected.has(row.noPesanan) ? "sel" : ""}>
                    <td><input type="checkbox" checked={selected.has(row.noPesanan)} onChange={(event) => toggle(row.noPesanan, event.target.checked)} /></td>
                    <td data-label="No Pesanan"><b>{row.noPesanan}</b>{row.current.lossSibling ? <div><span className="pill p-pur">-R · Barang Hilang</span></div> : null}<div className="mut">{row.current.customerName}</div></td>
                    <td data-label="Tgl">{row.day}</td>
                    <td data-label="Toko">{row.current.storeName}</td>
                    <td data-label="Channel">{row.current.channel}</td>
                    <td data-label="Status">{row.current.status}{row.current.returnCase ? <div className="small mut">Case {row.current.returnCase}</div> : null}</td>
                    <td data-label="Revenue" className="n">{rp(row.current.revenue)}</td>
                    <td data-label="Alasan">
                      <span className={`pill ${why === SYNC_FAILED_REASON ? "p-bad" : "p-warn"}`} title={row.lastSyncError || undefined}>{why}</span>
                      {why === SYNC_FAILED_REASON && row.lastSyncError ? <div className="small" style={{ maxWidth: 280, whiteSpace: "normal" }} title={row.lastSyncError}>{row.lastSyncError}</div> : null}
                    </td>
                    <td data-label="Tutup buku">{closed ? <span className="pill p-gray">Sudah</span> : <span className="pill p-ok">Belum</span>}</td>
                    <td data-label="Tindakan"><span className={`pill ${intent.block ? "p-gray" : intent.label.startsWith("Hapus") ? "p-bad" : intent.label.startsWith("Buat Retur") || intent.label.startsWith("Ubah") ? "p-warn" : "p-info"}`}>{intent.label}</span></td>
                    <td data-label="Updated">{stamp(row.current.contentUpdatedAt)}</td>
                    <td data-label="Synced">{stamp(row.syncedAt)}</td>
                    <td className="nowrap">
                      <button className="btn sm pri" disabled={busy || intent.block || intent.label.startsWith("Tidak dikirim")} title={intent.block ? "Sudah tutup buku — hanya Abaikan" : intent.label.startsWith("Tidak dikirim") ? "Tidak dikirim. Gunakan Abaikan." : "Sync"} onClick={() => setConfirm([row.noPesanan])}>Sync</button>
                      <ActionButton className="btn sm" disabled={busy} onClick={() => ignore([row.noPesanan])}>Abaikan</ActionButton>
                    </td>
                  </tr>
                );
              })}
              {!described.length ? <tr><td colSpan={13} className="empty">{q || from || to || store || channel || reason || action ? "Tidak ada pesanan untuk filter ini." : "Semua pesanan sudah tersinkron ke Accurate."}</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={page} pageSize={pageSize} total={total} shown={described.length} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(0); }} />
      </TableShell>
      <div className="tablecard mt">
        <div className="th3"><b>Log sinkron</b> <span className="small mut">setiap Sync dan Abaikan dicatat siapa dan kapan</span></div>
        <div className="tscroll"><table className="small cards"><thead><tr><th>Waktu</th><th>Oleh</th><th>Aksi</th><th>No pesanan</th><th>Keterangan</th></tr></thead><tbody>
          {logPage.shown.map((entry, index) => (
            <tr key={`${entry.at}-${entry.noPesanan}-${index}`}>
              <td data-label="Waktu">{stamp(entry.at)}</td>
              <td data-label="Oleh">{entry.actor || "—"}</td>
              <td data-label="Aksi"><span className={`pill ${entry.action === "ignore" ? "p-gray" : entry.action === "blocked" ? "p-warn" : "p-info"}`}>{entry.note.startsWith("Pelanggan") || entry.note.startsWith("Nama pembeli") ? "Pelanggan" : entry.action === "ignore" ? "Abaikan Sync" : entry.action === "sync" ? "Sync ke Accurate" : "Ditahan"}</span></td>
              <td data-label="No">{entry.noPesanan}</td>
              <td data-label="Keterangan" className="small">{entry.note}</td>
            </tr>
          ))}
          {!log.length ? <tr><td colSpan={5} className="mut">Belum ada log.</td></tr> : null}
        </tbody></table></div>
        <Pager page={logPage.page} pageSize={logPage.pageSize} total={logPage.total} shown={logPage.shown.length} onPage={logPage.setPage} onPageSize={logPage.setPageSize} />
      </div>
      {confirm ? (
        <div className="modal-bg on" onClick={(event) => { if (event.target === event.currentTarget) setConfirm(null); }}>
          <div className="modal">
            <h2>Sync {confirm.length} pesanan ke Accurate?</h2>
            {!meta ? <div className="small mut">Memeriksa status pengiriman…</div> : null}
            {meta && salesPush && databaseId ? <div className="note mt">Data AKAN dikirim ke Accurate (database {databaseLabel}). Cancel yang sudah tutup buku tidak masuk tombol ini.</div> : null}
            {meta && salesPush && !databaseId ? <div className="warnbox mt">ID database Accurate kosong. Sync ditahan sampai database diisi di Koneksi Accurate.</div> : null}
            {meta && !salesPush ? <div className="small mut">Tidak ada data yang dikirim selama ACCURATE_SALES_PUSH belum enabled. Cancel yang sudah tutup buku tidak masuk tombol ini.</div> : null}
            {meta && !salesPush ? <div className="warnbox mt">Guard penjualan masih aktif. Accurate production tidak menerima penjualan, cancel, atau retur dari tombol ini.</div> : null}
            <InvoicePreview rows={detailsFor(confirm).map((item) => ({
              noPesanan: item.row.noPesanan,
              total: invoiceTotals(item.row.current).net,
            }))} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button className="btn" onClick={() => setConfirm(null)}>Batal</button>
              <ActionButton className="btn pri" disabled={busy || (salesPush && !databaseId)} onClick={() => syncNow(confirm)}>Sync sekarang</ActionButton>
            </div>
          </div>
        </div>
      ) : null}
      {rulesOpen ? (
        <div className="modal-bg on" onClick={(event) => { if (event.target === event.currentTarget) setRulesOpen(false); }}>
          <div className="modal" style={{ width: 760 }}>
            <h2>Aturan ke Accurate · Cancel / Retur / Tutup buku</h2>
            <ol className="rules">
              <li>Cancel belum tutup buku: status CANCELED di web, penjualan dihapus saat sync. Tidak di-soft-delete. {salesPush ? "Pengiriman penjualan sedang aktif." : "Pengiriman masih ditahan guard."}</li>
              <li>Cancel sudah tutup buku: tidak diproses otomatis. Hanya Abaikan, lalu Finance menangani manual.</li>
              <li>Retur Case 1: harga web tetap. Belum tutup buku = hapus penjualan. Sudah tutup buku = buat Retur.</li>
              <li>Retur Case 2 dan 3: pesanan asal tetap berharga. Pesanan -R harga 0, channel Internal, toko Barang Hilang, masuk sebagai penjualan biasa.</li>
              <li>Cancel atau retur yang belum pernah sync tidak dikirim. Keluarkan dengan Abaikan.</li>
            </ol>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}><button className="btn pri" onClick={() => setRulesOpen(false)}>Mengerti</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
