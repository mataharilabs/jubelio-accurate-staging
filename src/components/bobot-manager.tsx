"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import type { BundleWeight } from "@/lib/db/types";

export function BobotManager() {
  const [rows, setRows] = useState<BundleWeight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [key, setKey] = useState("");
  const [bobot, setBobot] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);

  function load() {
    setError(null);
    api<BundleWeight[]>("/api/weights")
      .then(setRows)
      .catch((err: Error) => setError(err.message));
  }

  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows) return [];
    if (!q) return rows;
    return rows.filter((row) => row.bundleKey.toLowerCase().includes(q));
  }, [rows, query]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api("/api/weights", { method: "POST", body: JSON.stringify({ bundleKey: key, bobot: Number(bobot) }) });
      setKey("");
      setBobot("");
      setNotice("Bobot disimpan.");
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gagal menyimpan.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setNotice(null);
    const form = new FormData();
    form.append("file", file);
    if (replace) form.append("replace", "1");
    try {
      const result = await api<{ count: number }>("/api/weights", { method: "POST", body: form });
      setNotice(replace ? `Tabel diganti. ${result.count} kunci tersimpan.` : `Kunci diperbarui. Total ${result.count} kunci.`);
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gagal mengunggah.");
    } finally {
      setBusy(false);
    }
  }

  async function saveBobot(row: BundleWeight, value: string) {
    const next = Number(value);
    if (!Number.isFinite(next) || next === row.bobot) return;
    try {
      await api(`/api/weights/${row.id}`, { method: "PATCH", body: JSON.stringify({ bobot: next }) });
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gagal mengubah bobot.");
    }
  }

  async function remove(row: BundleWeight) {
    if (!window.confirm(`Hapus kunci ${row.bundleKey}?`)) return;
    await api(`/api/weights/${row.id}`, { method: "DELETE" });
    load();
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-danger">{error}</p>
        <Button className="mt-4" variant="secondary" onClick={load}>Coba lagi</Button>
      </div>
    );
  }
  if (!rows) return <p className="text-sm text-muted">Memuat tabel bobot…</p>;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Bobot bundle</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Kunci di kolom B adalah <span className="font-mono text-[13px]">SKU bundle-kode item</span>. Bobot mengalikan harga dan diskon saat baris bundle dipecah. Baris penjualan yang kuncinya tidak ada ditandai, tidak dibuang.
      </p>
      {notice ? <p className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">{notice}</p> : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <form onSubmit={add} className="rounded-xl border border-border bg-card p-4">
          <div className="font-medium">Tambah atau perbarui satu kunci</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px_auto]">
            <Input placeholder="SKU-ITEM" value={key} onChange={(event) => setKey(event.target.value)} aria-label="Kunci bundle" />
            <Input placeholder="0.25" value={bobot} onChange={(event) => setBobot(event.target.value)} aria-label="Bobot" inputMode="decimal" />
            <Button type="submit" disabled={busy}>Simpan</Button>
          </div>
        </form>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="font-medium">Unggah tabel Excel</div>
          <p className="mt-1 text-sm text-muted">Lembar Tabel Bundle, kolom B kunci, kolom C bobot. Baris judul SKU BUNDLE diabaikan.</p>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} className="h-4 w-4 accent-[#0e6b4f]" />
            Ganti seluruh tabel, jangan gabungkan
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">
              Pilih berkas
              <input type="file" accept=".xlsx" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
            </label>
            {/* Unduhan berkas, bukan navigasi halaman. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/api/weights/export" className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-[#f6f2e9]">Unduh tabel</a>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Input className="max-w-sm" placeholder="Cari kunci" value={query} onChange={(event) => setQuery(event.target.value)} />
        <span className="text-sm text-muted">{filtered.length.toLocaleString("id-ID")} dari {rows.length.toLocaleString("id-ID")} kunci</span>
      </div>

      <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-[#f6f2e9] text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">SKU bundle</th>
              <th className="px-4 py-3 font-medium">Bobot per item</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-muted">Tidak ada kunci. Unggah tabel atau muat sampel dari dasbor.</td></tr>
            ) : filtered.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="px-4 py-2 font-mono text-[13px]">{row.bundleKey}</td>
                <td className="px-4 py-2">
                  <Input
                    key={`${row.id}-${row.bobot}`}
                    className="h-8 max-w-[160px] font-mono"
                    defaultValue={String(row.bobot)}
                    aria-label={`Bobot ${row.bundleKey}`}
                    onBlur={(event) => void saveBobot(row, event.target.value)}
                  />
                </td>
                <td className="px-4 py-2 text-right">
                  <button className="text-sm text-danger" onClick={() => void remove(row)}>Hapus</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
