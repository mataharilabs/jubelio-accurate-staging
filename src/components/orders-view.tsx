"use client";

import { useEffect, useState } from "react";
import { downloadExport } from "@/components/download";
import { api } from "@/lib/api-client";
import type { AppMeta, OrderPage, OrderPageRow } from "@/lib/db/types";
import { booksClosed, needsAccurateSync, yesterdayWib } from "@/lib/domain/phase3";
import { numId, rp } from "@/lib/format";

const CASES = [
  { id: 1 as const, label: "Case 1 · Balik semua", hint: "Semua barang kembali" },
  { id: 2 as const, label: "Case 2 · Balik sebagian", hint: "Sebagian barang hilang" },
  { id: 3 as const, label: "Case 3 · Tidak balik semua", hint: "Semua barang hilang" },
];

export function OrdersView() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [storeName, setStoreName] = useState("");
  const [sync, setSync] = useState<"" | "need" | "done">("");
  const [dataStatus, setDataStatus] = useState<"active" | "deleted" | "all">("active");
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [channelOptions, setChannelOptions] = useState<string[]>([]);
  const [storeOptions, setStoreOptions] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<OrderPage | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ppn, setPpn] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [edit, setEdit] = useState<OrderPageRow | null>(null);
  const [form, setForm] = useState({ sku: "", qty: "", unitPrice: "", city: "", status: "COMPLETED", returnCase: 1 as 1 | 2 | 3 });
  const [lostQty, setLostQty] = useState("");
  const [rules, setRules] = useState(false);
  const [duplicate, setDuplicate] = useState<"overwrite" | "skip">("overwrite");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function queryString(nextPage = page, nextFrom = from, nextTo = to, nextStatus = status, nextQ = q, nextData = dataStatus, nextChannel = channel, nextStore = storeName, nextSync = sync) {
    const params = new URLSearchParams({ q: nextQ, page: String(nextPage), dataStatus: nextData });
    if (nextFrom) params.set("from", nextFrom);
    if (nextTo) params.set("to", nextTo);
    if (nextStatus) params.set("statuses", nextStatus);
    if (nextChannel) params.set("channels", nextChannel);
    if (nextStore) params.set("stores", nextStore);
    if (nextSync) params.set("sync", nextSync);
    return params.toString();
  }

  async function load(nextPage = page, nextFrom = from, nextTo = to, nextStatus = status, nextQ = q, nextData = dataStatus, nextChannel = channel, nextStore = storeName, nextSync = sync) {
    setData(await api<OrderPage>(`/api/orders?${queryString(nextPage, nextFrom, nextTo, nextStatus, nextQ, nextData, nextChannel, nextStore, nextSync)}`));
  }

  useEffect(() => {
    api<{ options?: { statuses?: string[]; channels?: string[]; stores?: string[] } }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query: { granularity: "day" }, includeOptions: true }),
    }).then((result) => {
      setStatusOptions(result.options?.statuses ?? []);
      setChannelOptions(result.options?.channels ?? []);
      setStoreOptions(result.options?.stores ?? []);
    }).catch(() => undefined);
    api<AppMeta>("/api/meta").then((meta) => setPpn(meta.ppnReportDate ?? null)).catch(() => undefined);
    load(0, "", "", "", "", "active", "", "", "").catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!edit) return;
    const lineChanged = form.sku !== edit.sku || Number(form.qty) !== edit.qty || Number(form.unitPrice) !== Number(edit.unitPrice ?? 0) || form.city !== edit.city;
    const statusChanged = form.status !== edit.status && (form.status === "RETURNED" || form.status === "CANCELED");
    if (!lineChanged && !statusChanged) throw new Error("Tidak ada perubahan data, retur, atau cancel.");
    if (lineChanged) {
      await api("/api/orders/edit", {
        method: "POST",
        body: JSON.stringify({ noPesanan: edit.noPesanan, lineId: edit.lineId, sku: form.sku, qty: Number(form.qty), unitPrice: Number(form.unitPrice), city: form.city }),
      });
    }
    if (statusChanged) {
      await api("/api/orders/return", {
        method: "POST",
        body: JSON.stringify({
          noPesanan: edit.noPesanan,
          status: form.status,
          returnCase: form.status === "RETURNED" ? form.returnCase : null,
          lost: form.returnCase === 2 ? [{ sku: form.sku || edit.sku, qty: Number(lostQty || form.qty || edit.qty) }] : [],
        }),
      });
    }
    setEdit(null);
    await load();
  }

  async function setOrderStatus(row: OrderPageRow, next: "active" | "deleted") {
    await api("/api/orders/status", { method: "POST", body: JSON.stringify({ noPesanan: row.noPesanan, dataStatus: next }) });
    await load();
  }

  async function bulkDelete() {
    const nos = [...picked];
    const blocked: string[] = [];
    let removed = 0;
    for (const noPesanan of nos) {
      const sample = data?.rows.find((row) => row.noPesanan === noPesanan);
      if (sample?.synced) {
        blocked.push(noPesanan);
        continue;
      }
      try {
        await api("/api/orders/status", { method: "POST", body: JSON.stringify({ noPesanan, dataStatus: "deleted" }) });
        removed += 1;
      } catch (err) {
        blocked.push(noPesanan);
        setError(err instanceof Error ? err.message : "Gagal menghapus.");
      }
    }
    setPicked(new Set());
    if (blocked.length) setError(`${blocked.length} pesanan tidak dihapus karena sudah sync ke Accurate. Ubah status ke Cancel atau Retur, lalu sync.`);
    if (removed) setMessage(`${removed} pesanan ditandai Dihapus.`);
    await load();
  }

  function exportOrders(format: "xlsx" | "pdf") {
    setExportOpen(false);
    downloadExport(`pesanan.${format}`, {
      target: "orders",
      format,
      from: from || null,
      to: to || null,
      statuses: status ? [status] : [],
      q,
      dataStatus,
      channels: channel ? [channel] : [],
      stores: storeName ? [storeName] : [],
      sync,
      nos: picked.size ? [...picked] : undefined,
    }).catch((err: Error) => setError(err.message));
  }

  async function pullYesterday() {
    const day = yesterdayWib();
    setMessage(`Menarik pesanan ${day} (H-1)…`);
    const result = await api<{ job: { status: string; stats?: { orders?: number; newVersions?: number } } }>("/api/jubelio/pull", { method: "POST", body: JSON.stringify({ from: day, to: day }) });
    setMessage(`Sync H-1 ${result.job.status}. ${result.job.stats?.orders ?? 0} pesanan dicek, ${result.job.stats?.newVersions ?? 0} versi baru.`);
    await load();
  }

  async function upload(file: File) {
    const formData = new FormData();
    formData.set("file", file);
    formData.set("mode", "raw");
    formData.set("duplicate", duplicate);
    if (from) formData.set("from", from);
    if (to) formData.set("to", to);
    const response = await fetch("/api/import", { method: "POST", body: formData });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Impor gagal.");
    setMessage(`Impor selesai. ${duplicate === "skip" ? "Duplikat dilewati." : "Duplikat ditimpa bila berubah."} Versi baru: ${body.newVersions}.`);
    await load();
  }

  return (
    <div>
      <div className="pagehead">
        <div className="desc">Perubahan data memperbarui Tgl Updated. Perubahan status biasa (bukan Retur/Cancel) tidak. Tombol Sync hanya menarik H-1. Pesanan yang sudah sync tidak bisa dihapus.</div>
        <div className="actions">
          <button className="btn pri" onClick={() => pullYesterday().catch((err: Error) => setError(err.message))}>Sync H-1</button>
          <label className="btn">Import<input hidden type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(file).catch((err: Error) => setError(err.message)); }} /></label>
          <select value={duplicate} onChange={(event) => setDuplicate(event.target.value as "overwrite" | "skip")} aria-label="Jika nomor pesanan sudah ada">
            <option value="overwrite">Timpa duplikat</option>
            <option value="skip">Lewati duplikat</option>
          </select>
          <button className="btn danger" disabled={!picked.size} onClick={() => bulkDelete().catch((err: Error) => setError(err.message))}>Hapus massal {picked.size ? `(${picked.size})` : ""}</button>
          <button className="btn" onClick={() => setExportOpen(true)}>Export {picked.size ? `(${picked.size})` : ""}</button>
          <button className="btn" onClick={() => setRules(true)}>Aturan Jubelio</button>
        </div>
      </div>
      {error ? <div className="warnbox">{error}</div> : null}
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      <div className="filterbar">
        <div className="f grow"><label>Cari</label><input value={q} placeholder="No pesanan, SKU, pelanggan, toko…" onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setPage(0); load(0).catch((err: Error) => setError(err.message)); } }} /></div>
        <div className="f"><label>Dari</label><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(0); load(0, event.target.value, to, status, q, dataStatus).catch((err: Error) => setError(err.message)); }} /></div>
        <div className="f"><label>Sampai</label><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(0); load(0, from, event.target.value, status, q, dataStatus).catch((err: Error) => setError(err.message)); }} /></div>
        <div className="f"><label>Status pesanan</label>
          <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); load(0, from, to, event.target.value, q, dataStatus).catch((err: Error) => setError(err.message)); }}>
            <option value="">Semua</option>
            {statusOptions.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>Channel</label>
          <select value={channel} onChange={(event) => { setChannel(event.target.value); setPage(0); load(0, from, to, status, q, dataStatus, event.target.value, storeName, sync).catch((err: Error) => setError(err.message)); }}>
            <option value="">Semua</option>
            {channelOptions.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>Toko</label>
          <select value={storeName} onChange={(event) => { setStoreName(event.target.value); setPage(0); load(0, from, to, status, q, dataStatus, channel, event.target.value, sync).catch((err: Error) => setError(err.message)); }}>
            <option value="">Semua</option>
            {storeOptions.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="f"><label>Status data</label>
          <select value={dataStatus} onChange={(event) => { const value = event.target.value as "active" | "deleted" | "all"; setDataStatus(value); setPage(0); load(0, from, to, status, q, value, channel, storeName, sync).catch((err: Error) => setError(err.message)); }}>
            <option value="active">Aktif</option>
            <option value="deleted">Dihapus</option>
            <option value="all">Semua</option>
          </select>
        </div>
        <div className="f"><label>Sinkron Accurate</label>
          <select value={sync} onChange={(event) => { const value = event.target.value as "" | "need" | "done"; setSync(value); setPage(0); load(0, from, to, status, q, dataStatus, channel, storeName, value).catch((err: Error) => setError(err.message)); }}>
            <option value="">Semua</option>
            <option value="need">Perlu sync</option>
            <option value="done">Sudah sync</option>
          </select>
        </div>
      </div>
      <div className="tablecard">
        <div className="tscroll">
          <table className="small cards">
            <thead><tr><th></th><th>No pesanan</th><th>Tgl</th><th>Channel</th><th>Toko</th><th>SKU</th><th className="n">Qty</th><th className="n">Revenue</th><th>Status</th><th>Status data</th><th>Tgl Updated</th><th>Tgl Synced</th><th></th></tr></thead>
            <tbody>
              {data?.rows.map((row) => {
                const need = needsAccurateSync({ dataStatus: row.dataStatus, contentUpdatedAt: row.contentUpdatedAt, syncedAt: row.syncedAt });
                return (
                <tr key={row.lineId} className={row.dataStatus === "deleted" ? "deleted" : ""}>
                  <td><input type="checkbox" checked={picked.has(row.noPesanan)} onChange={(event) => setPicked((current) => { const next = new Set(current); if (event.target.checked) next.add(row.noPesanan); else next.delete(row.noPesanan); return next; })} /></td>
                  <td data-label="No pesanan">{row.noPesanan}{row.lossSibling ? <div className="pill p-pur">-R</div> : null}<div className="mut">{row.customerName}</div></td>
                  <td data-label="Tanggal">{row.day}</td>
                  <td data-label="Channel">{row.channel}</td>
                  <td data-label="Toko">{row.storeName}</td>
                  <td data-label="SKU">{row.sku}<div className="mut">{row.productName}</div></td>
                  <td data-label="Qty" className="n">{numId(row.qty)}</td>
                  <td data-label="Revenue" className="n">{rp((row.revenuePerUnit ?? 0) * row.qty)}</td>
                  <td data-label="Status">{row.status || "—"}{row.returnCase ? <div className="small mut">Case {row.returnCase}</div> : null}</td>
                  <td data-label="Status data">{row.dataStatus === "deleted" ? <span className="pill p-bad">Dihapus</span> : <span className="pill p-ok">Aktif</span>}</td>
                  <td data-label="Updated">{row.contentUpdatedAt ? row.contentUpdatedAt.slice(0, 16).replace("T", " ") : "—"}</td>
                  <td data-label="Synced">{row.syncedAt ? row.syncedAt.slice(0, 16).replace("T", " ") : "—"}{need ? <div><span className="pill p-warn">Perlu sync</span></div> : null}</td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => { setEdit(row); setForm({ sku: row.sku, qty: String(row.qty), unitPrice: String(row.unitPrice ?? ""), city: row.city, status: row.status || "COMPLETED", returnCase: row.returnCase || 1 }); setLostQty(String(row.qty)); }}>Ubah</button>
                    {row.dataStatus === "deleted"
                      ? <button className="btn sm" onClick={() => setOrderStatus(row, "active").catch((err: Error) => setError(err.message))}>Pulihkan</button>
                      : <button className="btn sm" disabled={Boolean(row.synced)} title={row.synced ? "Sudah sync ke Accurate — tidak bisa dihapus. Ubah status ke Cancel atau Retur, lalu sync." : "Soft delete"} onClick={() => setOrderStatus(row, "deleted").catch((err: Error) => setError(err.message))}>Hapus</button>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span>{data ? `${data.total} baris · ${data.orders} pesanan · 25/halaman` : "Memuat…"}</span>
          <span>
            <button className="btn sm" disabled={!data?.page} onClick={() => { const next = (data?.page ?? 1) - 1; setPage(next); load(next).catch((err: Error) => setError(err.message)); }}>‹</button>
            <button className="btn sm on">{(data?.page ?? 0) + 1}</button>
            <button className="btn sm" disabled={!data || data.page >= data.pages - 1} onClick={() => { const next = (data?.page ?? 0) + 1; setPage(next); load(next).catch((err: Error) => setError(err.message)); }}>›</button>
          </span>
        </div>
      </div>
      {edit ? (
        <div className="modal-bg on"><div className="modal" style={{ width: 760 }}>
          <h2>Ubah pesanan</h2>
          <div className="small mut">{edit.noPesanan} · {edit.channel} / {edit.storeName}</div>
          {edit.synced ? <div className="note mt">Pesanan ini sudah sync ke Accurate sehingga tidak bisa dihapus. Untuk membatalkan, ubah status ke CANCELED atau RETURNED lalu sync.</div> : null}
          <div className="grid g2 mt">
            <div className="f"><label>SKU</label><input value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} /></div>
            <div className="f"><label>Qty</label><input type="number" value={form.qty} onChange={(event) => setForm({ ...form, qty: event.target.value })} /></div>
            <div className="f"><label>Harga satuan</label><input type="number" value={form.unitPrice} onChange={(event) => setForm({ ...form, unitPrice: event.target.value })} /></div>
            <div className="f"><label>Kota</label><input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></div>
            <div className="f"><label>Status pesanan</label>
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
                {["PROCESSING", "SHIPPED", "COMPLETED", "RETURNED", "CANCELED"].map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>
          </div>
          {form.status === "RETURNED" ? (
            <div className="note mt">
              <b>Jenis retur</b>
              <div className="choice">
                {CASES.map((item) => (
                  <label key={item.id} className={form.returnCase === item.id ? "on" : ""}>
                    <input type="radio" checked={form.returnCase === item.id} onChange={() => setForm({ ...form, returnCase: item.id })} />
                    <span><b>{item.label}</b><div className="small mut">{item.hint}</div></span>
                  </label>
                ))}
              </div>
              {form.returnCase === 2 ? <div className="f mt"><label>Qty hilang untuk SKU {form.sku || edit.sku} (harga 0, channel Internal, toko Barang Hilang)</label><input type="number" value={lostQty} onChange={(event) => setLostQty(event.target.value)} /></div> : null}
              {form.returnCase === 3 ? <div className="small mut mt">Case 3 membuat pesanan -R untuk semua produk pesanan ini, harga 0.</div> : null}
              <div className="small mut mt">Harga retur di web tidak di-nol-kan. Case 2 dan 3 membuat pesanan -R terpisah.</div>
            </div>
          ) : null}
          {form.status === "CANCELED" ? <div className="warnbox mt">{booksClosed(edit.day, ppn) ? "Pesanan ini sudah tutup buku. Cancel tidak diproses otomatis ke Accurate — di antrean hanya bisa diabaikan, lalu Finance menangani manual." : "Cancel mengubah status menjadi CANCELED dan tidak men-soft-delete pesanan. Accurate menghapus penjualan saat sync. Pengiriman masih ditahan guard."}</div> : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={() => setEdit(null)}>Batal</button>
            <button className="btn pri" onClick={() => save().catch((err: Error) => setError(err.message))}>Simpan</button>
          </div>
        </div></div>
      ) : null}
      {exportOpen ? (
        <div className="modal-bg on" onClick={(event) => { if (event.target === event.currentTarget) setExportOpen(false); }}><div className="modal">
          <h2>Export pesanan</h2>
          <div className="small mut">Jika tidak ada yang dicentang, semua hasil saringan yang diunduh. PDF dibatasi 200 baris; selebihnya pakai Excel.</div>
          <div className="small mt">{picked.size ? `${picked.size} pesanan dicentang.` : "Tidak ada centang — semua hasil filter."}</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={() => setExportOpen(false)}>Batal</button>
            <button className="btn" onClick={() => exportOrders("xlsx")}>Excel</button>
            <button className="btn pri" onClick={() => exportOrders("pdf")}>PDF</button>
          </div>
        </div></div>
      ) : null}
      {rules ? (
        <div className="modal-bg on" onClick={(event) => { if (event.target === event.currentTarget) setRules(false); }}><div className="modal">
          <h2>Aturan sync pesanan dari Jubelio</h2>
          <table><thead><tr><th>#</th><th>Kondisi</th><th>Tgl Updated</th></tr></thead><tbody>
            <tr><td>1</td><td>Belum ada di web → tambah</td><td>diisi</td></tr>
            <tr><td>2</td><td>Hanya status berubah, bukan Retur/Cancel</td><td>tetap</td></tr>
            <tr><td>3</td><td>Status menjadi Returned atau Canceled</td><td>diperbarui</td></tr>
            <tr><td>4</td><td>Data lain berubah</td><td>diperbarui</td></tr>
            <tr><td>5</td><td>Tidak berubah</td><td>tetap</td></tr>
          </tbody></table>
          <div className="note mt">Tombol di halaman ini hanya menarik kemarin (H-1). Cron harian tetap H-1 s/d H-3, mingguan H-4 s/d H-28.</div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}><button className="btn pri" onClick={() => setRules(false)}>Mengerti</button></div>
        </div></div>
      ) : null}
    </div>
  );
}
