"use client";

import { useEffect, useState } from "react";
import { downloadExport } from "@/components/download";
import { api } from "@/lib/api-client";
import type { OrderPage, OrderPageRow } from "@/lib/db/types";
import { dayLabel } from "@/lib/domain/aggregate";
import { numId } from "@/lib/format";

export function OrdersView() {
  const [day, setDay] = useState("");
  const [days, setDays] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<OrderPage | null>(null);
  const [edit, setEdit] = useState<OrderPageRow | null>(null);
  const [form, setForm] = useState({ sku: "", qty: "", unitPrice: "", city: "" });
  const [error, setError] = useState<string | null>(null);

  async function load(nextPage = page, nextDay = day, nextQ = q) {
    const result = await api<OrderPage>(`/api/orders?day=${nextDay}&q=${encodeURIComponent(nextQ)}&page=${nextPage}`);
    setData(result);
  }

  useEffect(() => {
    api<{ options?: { minDay: string | null; maxDay: string | null } }>("/api/dashboard", {
      method: "POST",
      body: JSON.stringify({ query: { granularity: "day" }, includeOptions: true }),
    }).then((result) => {
      const options = result.options;
      if (options?.minDay && options.maxDay) {
        const list: string[] = [];
        const cursor = new Date(`${options.minDay}T00:00:00Z`);
        const end = new Date(`${options.maxDay}T00:00:00Z`);
        while (cursor <= end && list.length < 400) {
          list.push(cursor.toISOString().slice(0, 10));
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        setDays(list);
      }
    }).catch(() => undefined);
    load(0, "", "").catch((err: Error) => setError(err.message));
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
          <div className="f"><label>Tanggal</label>
            <select value={day} onChange={(event) => { setDay(event.target.value); setPage(0); load(0, event.target.value, q); }}>
              <option value="">Semua</option>
              {days.map((value) => <option key={value} value={value}>{dayLabel(value)}</option>)}
            </select>
          </div>
          <div className="f"><label>Cari</label><input type="text" style={{ width: 280 }} placeholder="No pesanan, SKU, pelanggan, kota…" value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setPage(0); load(0, day, q); } }} /></div>
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => { setPage(0); load(0, day, q); }}>Cari</button></div>
          <span style={{ flex: 1 }} />
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => downloadExport("data-pesanan.xlsx", { target: "orders", format: "xlsx", day: day || null, q })}>Excel 17 kolom</button></div>
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => downloadExport("data-pesanan.pdf", { target: "orders", format: "pdf", day: day || null, q })}>PDF</button></div>
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
