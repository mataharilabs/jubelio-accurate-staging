"use client";

import { useEffect, useState } from "react";
import { downloadExport } from "@/components/download";
import { api } from "@/lib/api-client";
import type { OrderPage, OrderPageRow } from "@/lib/db/types";
import { numId } from "@/lib/format";

export function OrdersView() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<OrderPage | null>(null);
  const [edit, setEdit] = useState<OrderPageRow | null>(null);
  const [form, setForm] = useState({ sku: "", qty: "", unitPrice: "", city: "" });
  const [error, setError] = useState<string | null>(null);

  function queryString(nextPage = page, nextFrom = from, nextTo = to, nextStatuses = statuses, nextQ = q) {
    const params = new URLSearchParams({ q: nextQ, page: String(nextPage) });
    if (nextFrom) params.set("from", nextFrom);
    if (nextTo) params.set("to", nextTo);
    if (nextStatuses.length) params.set("statuses", nextStatuses.join(","));
    return params.toString();
  }

  async function load(nextPage = page, nextFrom = from, nextTo = to, nextStatuses = statuses, nextQ = q) {
    const result = await api<OrderPage>(`/api/orders?${queryString(nextPage, nextFrom, nextTo, nextStatuses, nextQ)}`);
    setData(result);
  }

  useEffect(() => {
    api<{ options?: { statuses?: string[] } }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query: { granularity: "day" }, includeOptions: true }),
    }).then((result) => setStatusOptions(result.options?.statuses ?? [])).catch(() => undefined);
    load(0, "", "", [], "").catch((err: Error) => setError(err.message));
    // Mount-only load. Later searches call load explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!edit) return;
    await api("/api/orders/edit", {
      method: "POST",
      body: JSON.stringify({
        noPesanan: edit.noPesanan,
        lineId: edit.lineId,
        sku: form.sku,
        qty: Number(form.qty),
        unitPrice: Number(form.unitPrice),
        city: form.city,
      }),
    });
    setEdit(null);
    await load();
  }

  async function remove(row: OrderPageRow) {
    if (!confirm(`Hapus baris ${row.sku} pada ${row.noPesanan}? Ini membuat versi baru.`)) return;
    await api("/api/orders/delete", { method: "POST", body: JSON.stringify({ noPesanan: row.noPesanan, lineId: row.lineId }) });
    await load();
  }

  return (
    <div>
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="card">
        <div className="filters">
          <div className="f"><label>Dari</label><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(0); load(0, event.target.value, to, statuses, q).catch((err: Error) => setError(err.message)); }} /></div>
          <div className="f"><label>Sampai</label><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(0); load(0, from, event.target.value, statuses, q).catch((err: Error) => setError(err.message)); }} /></div>
          <div className="f"><label>Status</label>
            <div className={`ms ${statusOpen ? "open" : ""}`}>
              <button type="button" className="btn" onClick={() => setStatusOpen((value) => !value)}>{statuses.length ? statuses.join(", ") : "Semua status"} ▾</button>
              {statusOpen ? <button type="button" className="ms-backdrop" aria-label="Tutup filter" onClick={() => setStatusOpen(false)} /> : null}
              <div className="pop">
                <button type="button" className="btn" style={{ display: "block", width: "100%", marginBottom: 4 }} onClick={() => { setStatuses([]); setStatusOpen(false); load(0, from, to, [], q).catch((err: Error) => setError(err.message)); }}>Semua status</button>
                {statusOptions.map((value) => (
                  <button key={value} type="button" className="btn" style={{ display: "block", width: "100%", marginBottom: 4 }} onClick={() => { const next = [value]; setStatuses(next); setStatusOpen(false); load(0, from, to, next, q).catch((err: Error) => setError(err.message)); }}>{value}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="f"><label>Cari</label><input type="text" style={{ width: 280 }} placeholder="No pesanan, SKU, pelanggan, kota…" value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setPage(0); load(0, from, to, statuses, q).catch((err: Error) => setError(err.message)); } }} /></div>
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => { setPage(0); load(0, from, to, statuses, q).catch((err: Error) => setError(err.message)); }}>Cari</button></div>
          <span style={{ flex: 1 }} />
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => downloadExport("data-pesanan.xlsx", { target: "orders", format: "xlsx", from: from || null, to: to || null, statuses, q }).catch((err: Error) => setError(err.message))}>Excel</button></div>
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => { if ((data?.total ?? 0) > 200) { setError("PDF terlalu besar untuk filter ini. Unduh Excel agar semua baris ikut."); return; } downloadExport("data-pesanan.pdf", { target: "orders", format: "pdf", from: from || null, to: to || null, statuses, q }).catch((err: Error) => setError(err.message)); }}>PDF</button></div>
        </div>
        <div className="small mut" style={{ marginTop: 8 }}>{data ? `${data.total} baris · ${data.orders} pesanan. Edit membuat versi baru dan tercatat.` : "Memuat…"}</div>
      </div>
      <div className="card mt" style={{ padding: 0, overflow: "auto" }}>
        <table className="small cards">
          <thead><tr>{["Tanggal", "No Pesanan", "Channel", "Store", "SKU", "Qty", "Unit Price", "Sub Total", "Total Nilai", "Total Diskon", "Unit Diskon", "Rev/Unit", "Customer", "Code", "Province", "City", "Kurir", "Status", ""].map((label) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>
            {data?.rows.map((row) => (
              <tr key={row.lineId}>
                <td data-label="Tanggal" className="nowrap">{row.tanggal.slice(5, 16).replace("T", " ")}</td>
                <td data-label="No Pesanan" className="nowrap">{row.noPesanan}</td>
                <td data-label="Channel">{row.channel}</td>
                <td data-label="Store">{row.storeName}</td>
                <td data-label="SKU">{row.sku}</td>
                <td data-label="Qty" className="n">{numId(row.qty)}</td>
                <td data-label="Unit Price" className="n">{numId(row.unitPrice)}</td>
                <td data-label="Sub Total" className="n">{numId(row.subTotal)}</td>
                <td data-label="Total Nilai" className="n">{numId(row.totalNilaiPesanan)}</td>
                <td data-label="Total Diskon" className="n">{numId(row.totalDiskon)}</td>
                <td data-label="Unit Diskon" className="n">{numId(row.unitDiskon)}</td>
                <td data-label="Rev/Unit" className="n">{numId(row.revenuePerUnit)}</td>
                <td data-label="Customer">{row.customerName}</td>
                <td data-label="Code">{row.customerCode}</td>
                <td data-label="Province">{row.province}</td>
                <td data-label="City">{row.city}</td>
                <td data-label="Kurir">{row.kurir}</td>
                <td data-label="Status">{row.status || "—"}</td>
                <td className="nowrap"><button className="btn sm" onClick={() => { setEdit(row); setForm({ sku: row.sku, qty: String(row.qty), unitPrice: String(row.unitPrice ?? ""), city: row.city }); }}>Edit</button> <button className="btn sm" onClick={() => remove(row)}>Hapus</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">halaman {(data?.page ?? 0) + 1}/{data?.pages ?? 1}<button className="btn sm" disabled={!data?.page} onClick={() => { const next = (data?.page ?? 1) - 1; setPage(next); load(next); }}>‹</button><button className="btn sm" disabled={!data || data.page >= data.pages - 1} onClick={() => { const next = (data?.page ?? 0) + 1; setPage(next); load(next); }}>›</button></div>
      <div className={`modal-bg ${edit ? "on" : ""}`}>
        <div className="modal">
          <h2>Edit baris · {edit?.noPesanan}</h2>
          <div className="mut small">{edit?.channel} / {edit?.storeName}</div>
          <div className="grid g2 mt">
            <div className="f"><label>SKU</label><input type="text" value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} /></div>
            <div className="f"><label>Qty</label><input type="number" value={form.qty} onChange={(event) => setForm({ ...form, qty: event.target.value })} /></div>
            <div className="f"><label>Unit Price</label><input type="number" value={form.unitPrice} onChange={(event) => setForm({ ...form, unitPrice: event.target.value })} /></div>
            <div className="f"><label>City</label><input type="text" value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></div>
          </div>
          <div className="note mt">Sub Total, Total Nilai Pesanan, Unit Diskon, dan Revenue per Unit dihitung ulang untuk seluruh pesanan. Perubahan ini jadi versi baru.</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={() => setEdit(null)}>Batal</button>
            <button className="btn pri" onClick={() => save().catch((err: Error) => setError(err.message))}>Simpan</button>
          </div>
        </div>
      </div>
    </div>
  );
}
