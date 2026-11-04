"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { numId, rp } from "@/lib/format";

type Catalog = { id: string; name: string; active: boolean };
type Product = { sku: string; name: string; categoryId: string | null; categoryName: string | null; brandId: string | null; brandName: string | null; accurateFound: string; hpp: number | null; hppSource: string | null; hppDate: string | null; hppCarried?: boolean };
type Rank = { sku?: string; name: string; category?: string; brand?: string; qty: number; net: number; hpp?: number | null; profit?: number | null; carried?: boolean };
type HppRun = { id?: string; status?: string; error?: string | null; okCount?: number; notFoundCount?: number; errorCount?: number; startedAt?: string; months?: string[] };
type Report = { coverage: { skus: number; withHpp: number; percent: number }; byNet: Rank[]; byQty: Rank[]; byProfit: Rank[]; brandsByNet: Rank[]; brandsByProfit: Rank[]; categoriesByNet: Rank[]; categoriesByProfit: Rank[] };

const RANKS: { key: keyof Report; title: string }[] = [
  { key: "byNet", title: "Produk menurut revenue bersih" },
  { key: "byQty", title: "Produk menurut qty" },
  { key: "byProfit", title: "Produk menurut laba kotor" },
  { key: "brandsByNet", title: "Brand menurut revenue" },
  { key: "brandsByProfit", title: "Brand menurut laba" },
  { key: "categoriesByNet", title: "Kategori menurut revenue" },
  { key: "categoriesByProfit", title: "Kategori menurut laba" },
];

function gp(row: Rank): string {
  if (row.profit == null) return row.sku ? "HPP belum ada" : "—";
  const pct = row.net ? Math.round((1000 * row.profit) / row.net) / 10 : 0;
  return `${rp(row.profit)} (${pct}%)`;
}

function hppText(row: Rank): string {
  if (row.hpp == null && row.profit == null && row.sku) return "HPP belum ada";
  if (row.hpp == null) return row.profit != null ? "HPP per bulan" : "—";
  return `${rp(row.hpp)}${row.carried ? " · HPP bulan sebelumnya" : ""}`;
}

function productHpp(row: Product): string {
  if (row.hpp == null) return "HPP belum ada";
  const source = row.hppSource === "manual" ? "manual" : "Accurate";
  return `${rp(row.hpp)} · ${source}${row.hppCarried ? " · HPP bulan sebelumnya" : ""}`;
}

export function ProductDashboard() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  async function load(nextFrom = from, nextTo = to, nextStatus = status) {
    const result = await api<Report>("/api/products/report", { method: "POST", body: JSON.stringify({ from: nextFrom || null, to: nextTo || null, statuses: nextStatus ? [nextStatus] : [] }) });
    setReport(result);
  }
  useEffect(() => { load().catch((err: Error) => setError(err.message)); 
    // Mount-only load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="card">
        <div className="filters">
          <div className="f"><label>Dari</label><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); load(event.target.value, to, status).catch((err: Error) => setError(err.message)); }} /></div>
          <div className="f"><label>Sampai</label><input type="date" value={to} onChange={(event) => { setTo(event.target.value); load(from, event.target.value, status).catch((err: Error) => setError(err.message)); }} /></div>
          <div className="f"><label>Status</label>
            <div className={`ms ${open ? "open" : ""}`}>
              <button type="button" className="btn" onClick={() => setOpen((value) => !value)}>{status || "Semua kecuali batal"} ▾</button>
              {open ? <button type="button" className="ms-backdrop" aria-label="Tutup filter" onClick={() => setOpen(false)} /> : null}
              <div className="pop">
                {["", "SHIPPED", "COMPLETED", "RETURNED", "PROCESSING"].map((value) => (
                  <button key={value || "all"} type="button" className="btn" style={{ display: "block", width: "100%", marginBottom: 4 }} onClick={() => { setStatus(value); setOpen(false); load(from, to, value).catch((err: Error) => setError(err.message)); }}>{value || "Semua kecuali batal"}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="f"><label>&nbsp;</label><button className="btn sm" onClick={() => { if (!report) return; import("xlsx").then((XLSX) => { const rows = RANKS.flatMap((rank) => ((report[rank.key] as Rank[]) ?? []).map((row) => ({ Peringkat: rank.title, Nama: row.name, SKU: row.sku ?? "", Qty: row.qty, "Revenue bersih": row.net, HPP: row.hpp ?? "", "Laba kotor": row.profit ?? "" }))); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Produk"); XLSX.writeFile(book, "produk.xlsx"); }).catch((err: Error) => setError(err.message)); }}>Excel</button></div>
        </div>
        <div className="note mt">Cakupan HPP {report ? `${report.coverage.percent}% (${report.coverage.withHpp}/${report.coverage.skus} SKU)` : "…"}. RETURNED ikut terhitung. Batal tidak ikut, kecuali dipilih di filter. Laba memakai HPP bulan penjualan. Jika bulan itu belum ada, dipakai HPP bulan sebelumnya.</div>
      </div>
      <div className="grid g2 mt">
        {RANKS.map((rank) => {
          const rows = (report?.[rank.key] as Rank[] | undefined) ?? [];
          const shown = all ? rows : rows.slice(0, 10);
          const max = Math.max(1, ...shown.map((row) => Number(row.net) || 0));
          return (
            <div className="card" key={rank.key}>
              <h3>{rank.title}</h3>
              <button className="btn sm" onClick={() => setAll((value) => !value)}>{all ? "Top 10" : "Lihat semua"}</button>
              <table className="small cards mt"><thead><tr><th>Nama</th><th>Qty</th><th>Revenue bersih</th><th>HPP</th><th>Laba kotor</th></tr></thead><tbody>
                {shown.map((row) => (
                  <tr key={`${rank.key}-${row.sku ?? row.name}`}>
                    <td data-label="Nama">{row.name}{row.sku ? <div className="mut">{row.sku}</div> : null}<div style={{ height: 6, background: "var(--line)", marginTop: 4 }}><div style={{ width: `${Math.max(4, ((Number(row.net) || 0) / max) * 100)}%`, height: 6, background: "var(--accent, #4f46e5)" }} /></div></td>
                    <td data-label="Qty" className="n">{numId(row.qty)}</td>
                    <td data-label="Revenue" className="n">{rp(row.net)}</td>
                    <td data-label="HPP" className="n">{hppText(row)}</td>
                    <td data-label="Laba" className="n">{gp(row)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProductList() {
  const [rows, setRows] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Catalog[]>([]);
  const [brands, setBrands] = useState<Catalog[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Partial<Product> & { unitCost?: string } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkBrand, setBulkBrand] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [run, setRun] = useState<HppRun | null>(null);
  const [runs, setRuns] = useState<HppRun[]>([]);
  const [configured, setConfigured] = useState(true);
  const [month, setMonth] = useState("");
  const [refreshAll, setRefreshAll] = useState(false);

  async function load(nextQ = q, nextFilter = filter, nextMonth = month) {
    const params = new URLSearchParams({ q: nextQ });
    if (nextMonth) params.set("month", nextMonth);
    if (nextFilter === "noHpp") params.set("noHpp", "1");
    if (nextFilter === "notInAccurate") params.set("notInAccurate", "1");
    if (nextFilter === "incomplete") params.set("incomplete", "1");
    const [products, categoryRows, brandRows, sync] = await Promise.all([
      api<{ rows: Product[]; month: string }>(`/api/products?${params}`),
      api<Catalog[]>("/api/catalog/kategori"),
      api<Catalog[]>("/api/catalog/merek"),
      api<{ run: HppRun | null; runs?: HppRun[]; configured: boolean }>("/api/products/sync"),
    ]);
    setRows(products.rows);
    if (!nextMonth && products.month) setMonth(products.month.slice(0, 7));
    setCategories(categoryRows);
    setBrands(brandRows);
    setRun(sync.run);
    setRuns(sync.runs ?? (sync.run ? [sync.run] : []));
    setConfigured(sync.configured);
  }
  useEffect(() => { load().catch((error: Error) => setMessage(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const missing = rows.filter((row) => row.accurateFound === "false");

  return (
    <div>
      {message ? <div className="warnbox">{message}</div> : null}
      {!configured || run?.error === "Accurate belum terhubung." ? <div className="warnbox">Accurate belum terhubung. HPP tetap bisa diisi manual.</div> : null}
      <div className="card">
        <div className="filters">
          <div className="f"><label>Cari</label><input value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") load(); }} /></div>
          <div className="f"><label>Filter</label>
            <div className={`ms ${open ? "open" : ""}`}>
              <button type="button" className="btn" onClick={() => setOpen((value) => !value)}>{filter === "noHpp" ? "Belum ada HPP" : filter === "notInAccurate" ? "Tidak ada di Accurate" : filter === "incomplete" ? "Belum lengkap" : "Semua"} ▾</button>
              {open ? <button type="button" className="ms-backdrop" aria-label="Tutup filter" onClick={() => setOpen(false)} /> : null}
              <div className="pop">
                {[[ "", "Semua" ], [ "noHpp", "Belum ada HPP" ], [ "notInAccurate", "Tidak ada di Accurate" ], [ "incomplete", "Belum lengkap" ]].map(([value, label]) => (
                  <button key={label} type="button" className="btn" style={{ display: "block", width: "100%", marginBottom: 4 }} onClick={() => { setFilter(value); setOpen(false); load(q, value).catch((error: Error) => setMessage(error.message)); }}>{label}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="f"><label>Bulan HPP</label><input type="month" value={month} onChange={(event) => { setMonth(event.target.value); load(q, filter, event.target.value).catch((error: Error) => setMessage(error.message)); }} /></div>
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => setEdit({ sku: "", name: "", unitCost: "" })}>Tambah produk</button></div>
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => api<{ run?: HppRun }>("/api/products/sync", { method: "POST", body: JSON.stringify({ refreshAll }) }).then((result) => { setRun(result.run ?? null); if (result.run?.error && result.run.error !== "Snapshot bulan ini sudah lengkap.") setMessage(result.run.error); return load(); }).catch((error: Error) => setMessage(error.message))}>Sync HPP Accurate</button></div>
          <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => api<{ changed?: number; fallback?: number; pending?: number; error?: string | null }>("/api/products/names", { method: "POST" }).then((result) => { setMessage(result.error && result.error !== "Tidak ada nama yang perlu diperbarui." ? result.error : `Nama Jubelio: ${result.changed ?? 0} berubah, ${result.fallback ?? 0} tetap, ${result.pending ?? 0} antre.`); return load(); }).catch((error: Error) => setMessage(error.message))}>Perbarui nama Jubelio</button></div>
          <label className="btn"><input type="checkbox" checked={refreshAll} onChange={(event) => setRefreshAll(event.target.checked)} /> Perbarui semua SKU bulan ini</label>
          <label className="btn">Impor Excel<input hidden type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const form = new FormData(); form.set("file", file); fetch("/api/products/import", { method: "POST", body: form }).then(() => load()); }} /></label>
          <a className="btn" href="/api/products/template">Ekspor mapping</a>
        </div>
        {missing.length ? <div className="note mt">Tidak ada di Accurate: {missing.map((row) => row.sku).join(", ")}</div> : null}
        {runs.length ? <div className="note mt">{runs.slice(0, 6).map((item) => <div key={item.id ?? item.startedAt}>{item.startedAt ? new Date(item.startedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "—"} · {item.status === "done" ? "selesai" : item.status === "failed" ? "gagal" : "berjalan"} · {item.okCount ?? 0} HPP, {item.notFoundCount ?? 0} tidak ada, {item.errorCount ?? 0} gagal{item.months?.length ? ` · ${item.months.join(", ")}` : ""}</div>)}</div> : null}
      </div>
      {picked.length ? (
        <div className="card mt filters">
          <select value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)}><option value="">Kategori</option>{categories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
          <select value={bulkBrand} onChange={(event) => setBulkBrand(event.target.value)}><option value="">Brand</option>{brands.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
          <button className="btn pri" onClick={() => api("/api/products", { method: "POST", body: JSON.stringify({ skus: picked, categoryId: bulkCategory || undefined, brandId: bulkBrand || undefined }) }).then(() => { setPicked([]); return load(); })}>Terapkan ke {picked.length} SKU</button>
        </div>
      ) : null}
      <div className="card mt" style={{ overflow: "auto" }}>
        <table className="cards small"><thead><tr><th></th><th>SKU</th><th>Nama</th><th>Kategori</th><th>Brand</th><th>HPP</th><th>Accurate</th><th></th></tr></thead><tbody>
          {rows.map((row) => (
            <tr key={row.sku}>
              <td><input type="checkbox" checked={picked.includes(row.sku)} onChange={() => setPicked((current) => current.includes(row.sku) ? current.filter((sku) => sku !== row.sku) : [...current, row.sku])} /></td>
              <td data-label="SKU">{row.sku}</td>
              <td data-label="Nama">{row.name || "Belum lengkap"}</td>
              <td data-label="Kategori">{row.categoryName || "(Tanpa kategori)"}</td>
              <td data-label="Brand">{row.brandName || "(Tanpa brand)"}</td>
              <td data-label="HPP">{productHpp(row)}</td>
              <td data-label="Accurate">{row.accurateFound === "false" ? "Tidak ada di Accurate" : row.accurateFound === "true" ? "Ada" : "Belum dicek"}</td>
              <td><button className="btn sm" onClick={() => setEdit({ ...row, unitCost: row.hpp == null ? "" : String(row.hpp) })}>Edit</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {edit ? (
        <div className="modal-bg on"><div className="modal">
          <h2>{edit.sku ? "Edit produk" : "Produk baru"}</h2>
          <div className="grid g2">
            <div className="f"><label>SKU</label><input value={edit.sku ?? ""} onChange={(event) => setEdit({ ...edit, sku: event.target.value })} /></div>
            <div className="f"><label>Nama</label><input value={edit.name ?? ""} onChange={(event) => setEdit({ ...edit, name: event.target.value })} /></div>
            <div className="f"><label>Kategori</label><select value={edit.categoryId ?? ""} onChange={(event) => setEdit({ ...edit, categoryId: event.target.value || null })}><option value="">(Tanpa kategori)</option>{categories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div>
            <div className="f"><label>Brand</label><select value={edit.brandId ?? ""} onChange={(event) => setEdit({ ...edit, brandId: event.target.value || null })}><option value="">(Tanpa brand)</option>{brands.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div>
            <div className="f"><label>HPP manual</label><input value={edit.unitCost ?? ""} onChange={(event) => setEdit({ ...edit, unitCost: event.target.value })} placeholder="Kosongkan jika tidak diubah" /></div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setEdit(null)}>Batal</button>
            <button className="btn pri" onClick={() => api("/api/products", { method: "POST", body: JSON.stringify({ sku: edit.sku, name: edit.name, categoryId: edit.categoryId, brandId: edit.brandId, periodMonth: month ? `${month}-01` : undefined, unitCost: edit.unitCost === "" || edit.unitCost == null ? undefined : Number(edit.unitCost) }) }).then(() => { setEdit(null); return load(); }).catch((error: Error) => setMessage(error.message))}>Simpan</button>
          </div>
        </div></div>
      ) : null}
    </div>
  );
}

export function CatalogEditor({ kind, title }: { kind: "kategori" | "merek"; title: string }) {
  const [rows, setRows] = useState<Catalog[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function load() { setRows(await api<Catalog[]>(`/api/catalog/${kind}`)); }
  useEffect(() => { load().catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  return (
    <div className="card">
      <h3>{title}</h3>
      {error ? <div className="warnbox">{error}</div> : null}
      <div className="filters"><input value={name} placeholder={`Nama ${title.toLowerCase()}`} onChange={(event) => setName(event.target.value)} /><button className="btn pri" onClick={() => api(`/api/catalog/${kind}`, { method: "POST", body: JSON.stringify({ name }) }).then(() => { setName(""); return load(); }).catch((err: Error) => setError(err.message))}>Tambah</button></div>
      <table className="cards mt"><tbody>
        {rows.map((row) => <tr key={row.id}><td>{row.name}</td><td><button className="btn sm" onClick={() => { const next = prompt("Nama baru", row.name); if (next) api(`/api/catalog/${kind}`, { method: "POST", body: JSON.stringify({ id: row.id, name: next, active: row.active }) }).then(load); }}>Edit</button></td></tr>)}
      </tbody></table>
    </div>
  );
}
