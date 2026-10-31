"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { downloadExport } from "@/components/download";
import { api } from "@/lib/api-client";
import type { AppMeta, FieldChange, OrderVersion, SyncBatch, SyncCategory, SyncReviewRow } from "@/lib/db/types";
import { numId, rp } from "@/lib/format";

const CATS: { id: SyncCategory; label: string; cls: string; hint: string }[] = [
  { id: "Baru", label: "Baru", cls: "p-baru", hint: "Belum pernah disync" },
  { id: "Berubah", label: "Berubah", cls: "p-berubah", hint: "Data selain status berubah sejak sync terakhir" },
  { id: "Returned", label: "Returned", cls: "p-returned", hint: "Status menjadi RETURNED, perlu sync ulang" },
  { id: "Batal", label: "Batal", cls: "p-batal", hint: "Dibatalkan setelah tersinkron — hapus invoice" },
  { id: "Status saja", label: "Status saja", cls: "p-status", hint: "Hanya status. Diperbarui di web, tidak disync" },
  { id: "Sama", label: "Sama", cls: "p-sama", hint: "Tidak ada perubahan, tidak disync ulang" },
];

const PRESET = new Set<SyncCategory>(["Baru", "Berubah", "Returned", "Batal"]);

function Pill({ category }: { category: SyncCategory }) {
  const item = CATS.find((row) => row.id === category);
  return <span className={`pill ${item?.cls ?? "p-sama"}`}>{category}</span>;
}

function moneyCell(current: number | null, previous: number | null, format: (value: number) => string) {
  if (previous == null || Math.abs((previous ?? 0) - (current ?? 0)) <= 0.5) return format(current ?? 0);
  return <><span className="old">{format(previous)}</span><br /><span className="chg">{format(current ?? 0)}</span></>;
}

export function SyncView() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [rows, setRows] = useState<SyncReviewRow[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [cats, setCats] = useState<Set<SyncCategory>>(new Set(PRESET));
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<"review" | "hist">("review");
  const [modal, setModal] = useState<"confirm" | "result" | null>(null);
  const [ack, setAck] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [history, setHistory] = useState<{ batches: SyncBatch[]; items: { noPesanan: string; status: string; error: string | null; category: string }[] }>({ batches: [], items: [] });
  const [histNo, setHistNo] = useState("");
  const [timeline, setTimeline] = useState<{ versions: OrderVersion[]; changes: FieldChange[] } | null>(null);

  async function load(nextDays = days) {
    const [metaRow, review] = await Promise.all([
      api<AppMeta>("/api/meta"),
      api<{ rows: SyncReviewRow[] }>(`/api/sync/review?days=${nextDays.join(",")}`),
    ]);
    setMeta(metaRow);
    let visible = review.rows;
    if (!nextDays.length) {
      const uniq = [...new Set(review.rows.map((row) => row.day).filter(Boolean))].sort();
      const picked = uniq.slice(-2);
      setDays(picked);
      if (uniq.length) {
        setFrom(uniq[0]);
        setTo(uniq[uniq.length - 1]);
      }
      if (picked.length) {
        const narrowed = await api<{ rows: SyncReviewRow[] }>(`/api/sync/review?days=${picked.join(",")}`);
        visible = narrowed.rows;
      }
    }
    setRows(visible);
    setSelected(new Set(visible.filter((row) => row.selectable && PRESET.has(row.category)).map((row) => row.noPesanan)));
  }

  useEffect(() => {
    load().catch((error: Error) => setMessage(error.message));
    // Mount-only load. Filters call load with the selected days.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allDays = useMemo(() => [...new Set(rows.map((row) => row.day).filter(Boolean))].sort(), [rows]);
  const filtered = rows.filter((row) => cats.has(row.category) && (!q || `${row.noPesanan} ${row.current.channel} ${row.current.storeName} ${row.current.customerName}`.toLowerCase().includes(q.toLowerCase())));
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  const pageRows = filtered.slice(page * 25, page * 25 + 25);
  const chosen = rows.filter((row) => selected.has(row.noPesanan) && row.selectable);
  const counts = Object.fromEntries(CATS.map((cat) => [cat.id, rows.filter((row) => row.category === cat.id).length]));

  async function upload(mode: "raw" | "clean", file: File) {
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.set("file", file);
    form.set("mode", mode);
    if (mode === "raw") {
      form.set("from", from);
      form.set("to", to);
    }
    try {
      const response = await fetch("/api/import", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Impor gagal.");
      setMessage(`Impor selesai: ${body.newVersions} versi baru, ${body.unchanged} tidak berubah, ${body.reviews} perlu review.`);
      await load(days);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Impor gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(noPesanan: string, decision: "confirmed" | "ignored") {
    await api("/api/sync/decision", { method: "POST", body: JSON.stringify({ noPesanan, decision }) });
    await load(days);
  }

  async function syncNow() {
    setBusy(true);
    try {
      const result = await api<{ batch: SyncBatch; items: { status: string; error: string | null }[] }>("/api/sync/execute", {
        method: "POST",
        body: JSON.stringify({ nos: chosen.map((row) => row.noPesanan) }),
      });
      setMessage(`Batch selesai. Berhasil ${result.batch.successCount}, gagal ${result.batch.failCount}.`);
      setModal("result");
      await load(days);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync gagal.");
      setModal("result");
    } finally {
      setBusy(false);
      setAck(false);
    }
  }

  const connected = Boolean(meta?.accurateConnected && meta.accurateConfigured);

  return (
    <div>
      {!connected ? <div className="banner" style={{ marginBottom: 12 }}>Accurate belum terhubung. Alur review tetap bisa dipakai. Pengiriman faktur baru jalan setelah OAuth di Koneksi Accurate.</div> : null}
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      <div className="stepper">
        <div className="step"><div className="no">1</div><div><b>Ambil data Jubelio</b><span>Upload Excel atau data contoh</span></div></div>
        <div className="step"><div className="no">2</div><div><b>Rapikan & simpan versi</b><span>Aturan 17 kolom yang disetujui</span></div></div>
        <div className="step cur"><div className="no">3</div><div><b>Bandingkan & review</b><span>Konfirmasi perubahan, lalu pilih</span></div></div>
        <div className={`step ${connected ? "" : "todo"}`}><div className="no">4</div><div><b>Sync ke Accurate</b><span>{connected ? "Sales Invoice" : "Belum terhubung"}</span></div></div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>1 · Ambil data Jubelio</h3>
          <div className="filters">
            <div className="f"><label>Dari</label><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
            <div className="f"><label>Sampai</label><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
            <div className="f"><label>Excel mentah</label><label className="btn">Pilih berkas<input hidden type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload("raw", file); }} /></label></div>
            <div className="f"><label>Excel sudah rapi</label><label className="btn">Pilih berkas<input hidden type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload("clean", file); }} /></label></div>
          </div>
          <p className="small mut" style={{ marginTop: 8 }}>Filter tanggal memakai 00:00–23:59 WIB. Status Pending/Paid/Cancel dibuang. RETURNED tetap. Pasangan channel/toko atau bobot yang belum dipetakan ditandai, tidak ditebak.</p>
          <button className="btn" disabled={busy} onClick={() => api("/api/seed", { method: "POST" }).then(() => load(days)).catch((error: Error) => setMessage(error.message))}>Muat data contoh 26–29 Okt</button>
        </div>
        <div className="card">
          <h3>2 · Aturan perbandingan</h3>
          <p className="small">Baru, Berubah, Returned, dan Batal ikut antrian. Perubahan harus dikonfirmasi dulu. “Dianggap tidak ada perubahan” mengeluarkan pesanan dari sync. Status saja hanya tercatat di web. Batal menyiapkan penghapusan invoice — SOP final masih terbuka.</p>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>3 · Perubahan Pesanan</button>
        <button className={tab === "hist" ? "on" : ""} onClick={() => { setTab("hist"); api<typeof history>("/api/sync/history").then(setHistory).catch(() => undefined); }}>Riwayat Sync</button>
      </div>
      {tab === "hist" ? (
        <div className="grid g32">
          <div className="card">
            <h3 style={{ display: "flex", gap: 8 }}>Batch sync <span style={{ flex: 1 }} /><button className="btn sm" onClick={() => downloadExport("riwayat-sync.xlsx", { target: "history", format: "xlsx" })}>Excel</button><button className="btn sm" onClick={() => downloadExport("riwayat-sync.pdf", { target: "history", format: "pdf" })}>PDF</button></h3>
            <div className="tbl"><table className="cards"><thead><tr><th>Waktu</th><th>Pesanan</th><th>Berhasil</th><th>Gagal</th><th>Catatan</th></tr></thead><tbody>
              {history.batches.map((batch) => <tr key={batch.id}><td data-label="Waktu">{batch.createdAt.slice(0, 16).replace("T", " ")}</td><td data-label="Pesanan">{batch.orderCount}</td><td data-label="Berhasil">{batch.successCount}</td><td data-label="Gagal">{batch.failCount}</td><td data-label="Catatan">{batch.note}</td></tr>)}
            </tbody></table></div>
          </div>
          <div className="card">
            <h3>Riwayat per pesanan</h3>
            <div className="filters"><input type="text" value={histNo} placeholder="No Pesanan" onChange={(event) => setHistNo(event.target.value)} /><button className="btn" onClick={() => api<{ versions: OrderVersion[]; changes: FieldChange[] }>(`/api/sync/history?no=${encodeURIComponent(histNo)}`).then(setTimeline)}>Cari</button></div>
            {timeline ? <ul className="small">{timeline.versions.map((version) => <li key={version.id}>v{version.versionNo} · {version.source} · {version.status} · {rp(version.totalNilaiPesanan)}</li>)}</ul> : null}
          </div>
        </div>
      ) : (
        <>
          <div className="sumchips">
            {CATS.map((cat) => (
              <button key={cat.id} className={`sc ${cats.has(cat.id) ? "on" : ""}`} title={cat.hint} onClick={() => { setCats((current) => { const next = new Set(current); if (next.has(cat.id)) next.delete(cat.id); else next.add(cat.id); return next; }); setPage(0); }}>
                <div className="v">{numId(counts[cat.id] ?? 0)}</div>
                <div className="l"><Pill category={cat.id} /></div>
              </button>
            ))}
          </div>
          <div className="filters" style={{ margin: "12px 0" }}>
            <button className="btn sm" onClick={() => setCats(new Set(PRESET))}>Hanya yang perlu tindakan</button>
            <button className="btn sm" onClick={() => setCats(new Set(CATS.map((cat) => cat.id)))}>Tampilkan semua</button>
            <div className="seg">{allDays.map((day) => <button key={day} className={days.includes(day) ? "on" : ""} onClick={() => { const next = days.includes(day) ? days.filter((item) => item !== day) : [...days, day]; setDays(next); load(next); }}>{day.slice(5)}</button>)}</div>
            <input type="text" placeholder="Cari no pesanan / toko / pelanggan…" value={q} onChange={(event) => { setQ(event.target.value); setPage(0); }} />
            <button className="btn sm" onClick={() => downloadExport("sync-review.xlsx", { target: "sync", format: "xlsx", days })}>Excel</button>
            <button className="btn sm" onClick={() => downloadExport("sync-review.pdf", { target: "sync", format: "pdf", days })}>PDF</button>
          </div>
          <div className="card" style={{ padding: 0, overflow: "auto" }}>
            <table className="cards">
              <thead><tr><th></th><th>No Pesanan</th><th>Channel / Toko</th><th>Perbandingan</th><th>Status</th><th className="n">Total Nilai</th><th className="n">Diskon</th><th className="n">Qty</th><th>Ringkasan</th><th></th></tr></thead>
              <tbody>
                {pageRows.map((row) => (
                  <Fragment key={row.noPesanan}>
                    <tr className={selected.has(row.noPesanan) ? "sel" : ""}>
                      <td data-label="Pilih"><input type="checkbox" disabled={!row.selectable} checked={selected.has(row.noPesanan)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(row.noPesanan); else next.delete(row.noPesanan); return next; })} /></td>
                      <td data-label="No Pesanan"><b>{row.noPesanan}</b><div className="mut small">{row.day}</div></td>
                      <td data-label="Channel"><b>{row.current.channel}</b><br /><span className="mut">{row.current.storeName}</span></td>
                      <td data-label="Kategori"><Pill category={row.category} /></td>
                      <td data-label="Status">{row.baseline && row.baseline.status !== row.current.status ? <><span className="old">{row.baseline.status}</span> → <span className="chg">{row.current.status || "—"}</span></> : row.current.status || "—"}</td>
                      <td data-label="Total" className="n">{moneyCell(row.current.totalNilaiPesanan, row.baseline?.totalNilaiPesanan ?? null, rp)}</td>
                      <td data-label="Diskon" className="n">{moneyCell(row.current.totalDiskon, row.baseline?.totalDiskon ?? null, rp)}</td>
                      <td data-label="Qty" className="n">{row.current.qty}</td>
                      <td data-label="Ringkasan" className="small">{row.summary}</td>
                      <td><button className="btn sm" onClick={() => setOpen(open === row.noPesanan ? null : row.noPesanan)}>{open === row.noPesanan ? "Tutup" : "Detail"}</button></td>
                    </tr>
                    {open === row.noPesanan ? (
                      <tr><td colSpan={10}>
                        <div className="detail">
                          <div>
                            <table className="small cards"><thead><tr><th>SKU</th><th className="n">Qty</th><th className="n">Unit Price</th><th className="n">Unit Diskon</th></tr></thead><tbody>
                              {row.current.lines.map((line) => {
                                const before = row.baseline?.lines.find((item) => item.sku === line.sku);
                                return <tr key={line.id}><td data-label="SKU">{line.sku}<div className="mut">{line.productName}</div></td><td data-label="Qty" className="n">{line.qty}</td><td data-label="Harga" className="n">{rp(line.unitPrice)}</td><td data-label="Diskon" className="n">{rp(line.unitDiskon)}{before ? null : <div className="pill p-baru">baru</div>}</td></tr>;
                              })}
                            </tbody></table>
                            {row.category === "Batal" ? <div className="warnbox" style={{ marginTop: 8 }}>Invoice di Accurate akan dihapus. SOP final belum ditetapkan — lanjut hanya bila sudah yakin.</div> : null}
                            {row.category === "Berubah" || row.category === "Returned" || row.category === "Batal" ? (
                              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                <button className="btn pri sm" onClick={() => decide(row.noPesanan, "confirmed")}>Konfirmasi perubahan</button>
                                <button className="btn sm" onClick={() => decide(row.noPesanan, "ignored")}>Dianggap tidak ada perubahan</button>
                              </div>
                            ) : null}
                          </div>
                          <div>
                            <div className="small"><b>Perubahan</b></div>
                            {row.changes.length ? row.changes.slice(0, 12).map((change) => <div key={change.id} className="small">{change.field}: <span className="old">{change.oldValue ?? "—"}</span> → {change.newValue ?? "—"}</div>) : <div className="mut small">Belum ada versi tersinkron untuk dibandingkan.</div>}
                          </div>
                        </div>
                      </td></tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">{filtered.length} pesanan · halaman {page + 1}/{pages}<button className="btn sm" disabled={!page} onClick={() => setPage((value) => value - 1)}>‹</button><button className="btn sm" disabled={page >= pages - 1} onClick={() => setPage((value) => value + 1)}>›</button></div>
          <div className="actionbar">
            <b>{chosen.length} pesanan siap sync</b>
            <span className="mut">{chosen.length ? `Total ${rp(chosen.reduce((sum, row) => sum + (row.current.totalNilaiPesanan ?? 0), 0))} · Revenue ${rp(chosen.reduce((sum, row) => sum + (row.current.revenue ?? 0), 0))}` : "Konfirmasi dulu pesanan yang berubah."}</span>
            <span style={{ flex: 1 }} />
            <button className="btn" disabled={!chosen.length} onClick={() => setSelected(new Set())}>Kosongkan</button>
            <button className="btn pri" disabled={!chosen.length || busy} onClick={() => { setAck(false); setModal("confirm"); }}>Sync ke Accurate ({chosen.length})</button>
          </div>
        </>
      )}
      <div className={`modal-bg ${modal ? "on" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
        <div className="modal">
          {modal === "confirm" ? (
            <>
              <h2>Kirim {chosen.length} pesanan ke Accurate?</h2>
              <div className="kv">
                {CATS.filter((cat) => chosen.some((row) => row.category === cat.id)).map((cat) => (
                  <div key={cat.id} style={{ display: "contents" }}><div><Pill category={cat.id} /> <span className="small mut">{cat.hint}</span></div><b>{chosen.filter((row) => row.category === cat.id).length} pesanan</b></div>
                ))}
                <div>Total Nilai Pesanan</div><b>{rp(chosen.reduce((sum, row) => sum + (row.current.totalNilaiPesanan ?? 0), 0))}</b>
                <div>Revenue bersih</div><b>{rp(chosen.reduce((sum, row) => sum + (row.current.revenue ?? 0), 0))}</b>
              </div>
              <div className="note">Item diskon dikirim sebagai <b>itemCashDiscount = Unit Diskon × Qty</b> per baris. Batal memanggil penghapusan invoice. SOP final belum ditetapkan.</div>
              {!connected ? <div className="warnbox" style={{ marginTop: 10 }}>Accurate belum terhubung. Tombol kirim akan menolak tanpa mengubah status sync.</div> : null}
              <label style={{ display: "flex", gap: 8, margin: "14px 0" }}><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> Saya sudah memeriksa perubahan pesanan di atas</label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="btn" onClick={() => setModal(null)}>Batal</button>
                <button className="btn pri" disabled={!ack || busy} onClick={syncNow}>Ya, sync {chosen.length} pesanan</button>
              </div>
            </>
          ) : modal === "result" ? (
            <>
              <h2>Hasil sync</h2>
              <p>{message}</p>
              <button className="btn pri" onClick={() => setModal(null)}>Tutup</button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
