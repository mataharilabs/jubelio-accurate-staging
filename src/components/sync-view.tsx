"use client";

import { useEffect, useMemo, useState } from "react";
import { ActionButton, reported, reportedOk, TableShell } from "@/components/ui/feedback";
import { Pager, useClientPage } from "@/components/ui/pager";
import { api } from "@/lib/api-client";
import type { AppMeta, SyncReviewRow } from "@/lib/db/types";
import { accurateIntent, needsAccurateSync, syncReason } from "@/lib/domain/phase3";
import { rp } from "@/lib/format";

type LogRow = { at: string; actor: string | null; action: string; noPesanan: string; note: string };
type SyncMeta = AppMeta & { salesPush?: boolean; accurateDatabaseId?: string };

const REASONS = ["Belum pernah sync", "Data berubah", "Status jadi RETURNED", "Status jadi CANCELED"];

function stamp(value?: string | null) {
  if (!value) return "—";
  return value.slice(0, 16).replace("T", " ");
}

export function SyncView() {
  const [meta, setMeta] = useState<SyncMeta | null>(null);
  const [rows, setRows] = useState<SyncReviewRow[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [store, setStore] = useState("");
  const [channel, setChannel] = useState("");
  const [reason, setReason] = useState("");
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [alias, setAlias] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [metaRow, review, history] = await Promise.all([
        api<SyncMeta>("/api/meta"),
        api<{ rows: SyncReviewRow[] }>("/api/sync/review"),
        api<{ log?: LogRow[] }>("/api/sync/history"),
      ]);
      setMeta(metaRow);
      setLog(history.log ?? []);
    const visible = review.rows.filter((row) => needsAccurateSync({
      dataStatus: row.current.dataStatus,
      contentUpdatedAt: row.current.contentUpdatedAt,
      syncedAt: row.syncedAt,
    }));
      setRows(visible);
      setSelected((current) => new Set([...current].filter((no) => visible.some((row) => row.noPesanan === no))));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, []);

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
    return { row, intent, why: syncReason(row.category, everSynced) };
  }), [rows, ppn]);

  const stores = [...new Set(rows.map((row) => row.current.storeName).filter(Boolean))].sort();
  const channels = [...new Set(rows.map((row) => row.current.channel).filter(Boolean))].sort();
  const actions = [...new Set(described.map((item) => item.intent.label))].sort();
  const filtered = described.filter((item) => {
    const text = `${item.row.noPesanan} ${item.row.current.customerName} ${item.row.current.storeName}`.toLowerCase();
    if (q && !text.includes(q.toLowerCase())) return false;
    if (from && item.row.day < from) return false;
    if (to && item.row.day > to) return false;
    if (store && item.row.current.storeName !== store) return false;
    if (channel && item.row.current.channel !== channel) return false;
    if (reason && item.why !== reason) return false;
    if (action && item.intent.label !== action) return false;
    return true;
  });
  const queue = useClientPage(filtered, "sync-queue", 25);
  const logPage = useClientPage(log, "sync-log", 50);
  const pageRows = queue.shown;
  const chosen = described.filter((item) => selected.has(item.row.noPesanan));
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

  async function ignore(nos: string[]) {
    setBusy(true);
    setError(null);
    try {
      for (const noPesanan of nos) {
        await api("/api/sync/decision", { method: "POST", body: JSON.stringify({ noPesanan, decision: "ignored" }) });
      }
      setMessage(reportedOk(`${nos.length} pesanan diabaikan. Tgl Synced diisi dan pesanan keluar dari antrean.`));
      setSelected(new Set());
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
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(reported(err, "Sync gagal."));
      setConfirm(null);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function toggle(no: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(no);
      else next.delete(no);
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
        <div className="f grow"><label>Cari</label><input value={q} placeholder="No pesanan, pelanggan…" onChange={(event) => { setQ(event.target.value); queue.setPage(0); }} /></div>
        <div className="f"><label>Dari</label><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); queue.setPage(0); }} /></div>
        <div className="f"><label>Sampai</label><input type="date" value={to} onChange={(event) => { setTo(event.target.value); queue.setPage(0); }} /></div>
        <div className="f"><label>Toko</label><select value={store} onChange={(event) => { setStore(event.target.value); queue.setPage(0); }}><option value="">Semua</option>{stores.map((item) => <option key={item}>{item}</option>)}</select></div>
        <div className="f"><label>Channel</label><select value={channel} onChange={(event) => { setChannel(event.target.value); queue.setPage(0); }}><option value="">Semua</option>{channels.map((item) => <option key={item}>{item}</option>)}</select></div>
        <div className="f"><label>Alasan</label><select value={reason} onChange={(event) => { setReason(event.target.value); queue.setPage(0); }}><option value="">Semua</option>{REASONS.map((item) => <option key={item}>{item}</option>)}</select></div>
        <div className="f"><label>Tindakan di Accurate</label><select value={action} onChange={(event) => { setAction(event.target.value); queue.setPage(0); }}><option value="">Semua</option>{actions.map((item) => <option key={item}>{item}</option>)}</select></div>
      </div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="cards small">
            <thead><tr><th></th><th>No Pesanan</th><th>Tgl Pesanan</th><th>Toko</th><th>Channel</th><th>Status</th><th className="n">Revenue Bersih</th><th>Alasan</th><th>Tutup buku</th><th>Tindakan di Accurate</th><th>Tgl Updated</th><th>Tgl Synced</th><th></th></tr></thead>
            <tbody>
              {pageRows.map(({ row, intent, why }) => {
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
                    <td data-label="Alasan"><span className="pill p-warn">{why}</span></td>
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
              {!pageRows.length ? <tr><td colSpan={13} className="empty">Semua pesanan sudah tersinkron ke Accurate.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={queue.page} pageSize={queue.pageSize} total={queue.total} shown={pageRows.length} onPage={queue.setPage} onPageSize={queue.setPageSize} />
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
