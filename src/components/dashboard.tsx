"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { formatDay, formatDateTime, formatRp } from "@/lib/format";
import type { Batch, DashboardStats } from "@/lib/db/types";

type DashboardResponse = {
  batches: Batch[];
  stats: DashboardStats;
  storage: { mode: "local" | "supabase"; ephemeral: boolean };
  accurate: { configured: boolean; connected: boolean };
};

export function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    setError(null);
    api<DashboardResponse>("/api/dashboard")
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }

  useEffect(load, []);

  async function upload(file: File) {
    setBusy("Mengunggah dan merapikan baris…");
    setNotice(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const batch = await api<Batch>("/api/batches", { method: "POST", body: form });
      router.push(`/batch/${batch.id}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gagal mengunggah.");
      setBusy(null);
    }
  }

  async function loadSample() {
    setBusy("Memuat berkas sampel 26 Oktober 2026…");
    setNotice(null);
    try {
      const batch = await api<Batch>("/api/sample", { method: "POST" });
      router.push(`/batch/${batch.id}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gagal memuat sampel.");
      setBusy(null);
    }
  }

  async function remove(batch: Batch) {
    if (!window.confirm(`Hapus batch ${batch.filename}? Baris dan status sinkronnya ikut terhapus.`)) return;
    setBusy("Menghapus batch…");
    try {
      await api(`/api/batches/${batch.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gagal menghapus.");
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-danger">{error}</p>
        <Button className="mt-4" variant="secondary" onClick={load}>Coba lagi</Button>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-muted">Memuat dasbor…</p>;

  const cards = [
    { label: "Nilai kotor", value: formatRp(data.stats.grossTotal) },
    { label: "Total diskon", value: formatRp(data.stats.discountTotal) },
    { label: "Pesanan belum sinkron", value: String(data.stats.unsyncedOrders) },
    { label: "Baris bobot hilang", value: String(data.stats.missingWeights) },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Batch penjualan</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {data.stats.batchCount} batch · {data.stats.lineCount.toLocaleString("id-ID")} baris bersih · {data.stats.weightCount.toLocaleString("id-ID")} kunci bobot.
            {data.accurate.connected ? " Accurate terhubung." : " Accurate belum terhubung — pratinjau payload tetap bisa dipakai."}
          </p>
        </div>
      </div>

      {data.storage.mode === "local" ? (
        <p className="mt-4 rounded-lg border border-[#ead9a8] bg-[#fff8e8] px-4 py-3 text-sm text-[#6d4e00]">
          {data.storage.ephemeral
            ? "Supabase belum diisi. Di Vercel data mode lokal hanya hidup sementara. Isi SUPABASE_URL, SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY."
            : "Penyimpanan lokal aktif (data/local-db.json). Untuk produksi, hubungkan Supabase seperti di README."}
        </p>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-muted">{card.label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[#cfc6b6] bg-card px-6 py-10 text-center">
          <Upload className="h-5 w-5 text-primary" />
          <span className="mt-3 font-medium">Unggah Laporan Penjualan Jubelio</span>
          <span className="mt-1 text-sm text-muted">Berkas .xlsx. Status Pending, Paid, dan Canceled dibuang. Bundle tanpa bobot ditandai, tidak dihapus.</span>
          <input
            type="file"
            accept=".xlsx"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
        </label>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 font-medium">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            Sampel 26 Oktober 2026
          </div>
          <p className="mt-2 text-sm text-muted">Lintas Surabaya dan Lintas Jakarta, lengkap dengan tabel bobot bundle. Berguna sebelum ekspor harian berikutnya tersedia.</p>
          <Button className="mt-4" variant="secondary" onClick={loadSample} disabled={Boolean(busy)}>Muat sampel</Button>
        </div>
      </div>
      {busy ? <p className="mt-3 text-sm text-primary">{busy}</p> : null}
      {notice ? <p className="mt-3 text-sm text-danger">{notice}</p> : null}

      <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-[#f6f2e9] text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Tanggal</th>
              <th className="px-4 py-3 font-medium">Berkas</th>
              <th className="px-4 py-3 font-medium">Baris</th>
              <th className="px-4 py-3 font-medium">Pesanan</th>
              <th className="px-4 py-3 font-medium">Belum sinkron</th>
              <th className="px-4 py-3 font-medium">Kotor</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {data.batches.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted">Belum ada batch. Unggah laporan Jubelio atau muat sampel.</td>
              </tr>
            ) : (
              data.batches.map((batch) => (
                <tr key={batch.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="font-medium">{formatDay(batch.reportDate)}</div>
                    <div className="text-xs text-muted">{formatDateTime(batch.createdAt)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/batch/${batch.id}`} className="font-medium text-primary hover:underline">{batch.filename}</Link>
                    {batch.missingWeightCount > 0 ? (
                      <div className="text-xs text-warning">{batch.missingWeightCount} bobot hilang</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{batch.rowCount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-3 tabular-nums">{batch.orderCount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-3 tabular-nums">{batch.unsyncedCount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-3 tabular-nums">{formatRp(batch.grossTotal)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => remove(batch)}>Hapus</Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
