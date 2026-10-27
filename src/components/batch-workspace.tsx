"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/api-client";
import { lineAmount } from "@/lib/cleanup/rapikan";
import { formatDateTime, formatDay, formatDecimal, formatNumber, formatRp, SYNC_LABEL } from "@/lib/format";
import type { Batch, LinePatch, OrderSync, SalesLine, SyncStatus } from "@/lib/db/types";
import type { OrderPreview } from "@/lib/sync-types";

type Bundle = { batch: Batch; lines: SalesLine[]; syncs: OrderSync[] };
type ExecuteResult = { results: { noPesanan: string; status: string; accurateNumber: string | null; error: string | null }[] };

const PAGE = 40;

const syncTone: Record<SyncStatus, string> = {
  belum: "bg-[#efeae0] text-[#5c564c]",
  pratinjau: "bg-[#e7eef8] text-[#1d4f8f]",
  tersinkron: "bg-[#e5f4ec] text-[#0e6b4f]",
  gagal: "bg-[#fdecec] text-[#9d2c2c]",
};

function qtyText(value: number) {
  return Number.isInteger(value) ? String(value) : formatNumber(value, 2);
}

export function BatchWorkspace({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [data, setData] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [channel, setChannel] = useState("");
  const [lokasi, setLokasi] = useState("");
  const [status, setStatus] = useState("");
  const [sync, setSync] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<SalesLine | null>(null);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [preview, setPreview] = useState<OrderPreview[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewSelection, setPreviewSelection] = useState<{ lineIds?: string[]; orderNos?: string[] }>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  function load() {
    setError(null);
    return api<Bundle>(`/api/batches/${batchId}`)
      .then((bundle) => {
        setData(bundle);
        setSelected((prev) => {
          const ids = new Set(bundle.lines.map((line) => line.id));
          return new Set([...prev].filter((id) => ids.has(id)));
        });
      })
      .catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  const syncByOrder = useMemo(() => new Map((data?.syncs ?? []).map((row) => [row.noPesanan, row])), [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const query = q.trim().toLowerCase();
    return data.lines.filter((line) => {
      if (channel && line.channel !== channel) return false;
      if (lokasi && line.lokasiGudang !== lokasi) return false;
      if (status && line.status !== status) return false;
      if (sync && line.syncStatus !== sync) return false;
      if (!query) return true;
      return [line.noPesanan, line.noPesananSumber, line.sku, line.namaToko, line.namaBarang, line.bundleKey]
        .some((value) => (value ?? "").toLowerCase().includes(query));
    });
  }, [data, q, channel, lokasi, status, sync]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * PAGE, safePage * PAGE);
  const allChecked = filtered.length > 0 && filtered.every((line) => selected.has(line.id));
  const someChecked = filtered.some((line) => selected.has(line.id));

  const totals = useMemo(() => {
    const gross = filtered.reduce((sum, line) => sum + lineAmount(line), 0);
    const discount = filtered.reduce((sum, line) => sum + (line.totalDiskon ?? 0), 0);
    const orders = new Set(filtered.map((line) => line.noPesanan)).size;
    const missing = filtered.filter((line) => line.missingWeight).length;
    return { gross, discount, orders, missing };
  }, [filtered]);

  const options = useMemo(() => {
    const lines = data?.lines ?? [];
    const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
    return {
      channels: unique(lines.map((line) => line.channel)),
      lokasi: unique(lines.map((line) => line.lokasiGudang)),
      statuses: unique(lines.map((line) => line.status)),
    };
  }, [data]);

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) filtered.forEach((line) => next.delete(line.id));
      else filtered.forEach((line) => next.add(line.id));
      return next;
    });
  }

  async function openPreview(selection: { lineIds?: string[]; orderNos?: string[] }) {
    setBusy(true);
    setBanner(null);
    try {
      const result = await api<{ orders: OrderPreview[] }>("/api/sync/preview", {
        method: "POST",
        body: JSON.stringify({ batchId, ...selection }),
      });
      setPreview(result.orders);
      setPreviewIndex(0);
      setPreviewSelection(selection);
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Gagal membuat pratinjau.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setBanner(null);
    try {
      const result = await api<ExecuteResult>("/api/sync/execute", {
        method: "POST",
        body: JSON.stringify({ batchId, ...previewSelection }),
      });
      const ok = result.results.filter((row) => row.status === "tersinkron").length;
      const failed = result.results.filter((row) => row.status === "gagal").length;
      const skipped = result.results.filter((row) => row.status === "dilewati").length;
      setBanner(`Selesai. ${ok} tersinkron, ${failed} gagal, ${skipped} dilewati.`);
      setPreview(null);
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Gagal mengirim ke Accurate.");
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    setBusy(true);
    try {
      const result = await api<{ deleted: number; blocked: number }>("/api/lines/delete", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected] }),
      });
      setSelected(new Set());
      setConfirmDelete(false);
      setBanner(
        result.blocked
          ? `${result.deleted} baris dihapus. ${result.blocked} baris tersinkron tidak dihapus.`
          : `${result.deleted} baris dihapus.`,
      );
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Gagal menghapus.");
    } finally {
      setBusy(false);
    }
  }

  async function recalc() {
    setBusy(true);
    try {
      const result = await api<{ updated: number; skipped: number }>(`/api/batches/${batchId}/recalc`, { method: "POST" });
      setBanner(`Bobot dihitung ulang pada ${result.updated} baris. ${result.skipped} baris tersinkron dilewati.`);
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Gagal menghitung ulang.");
    } finally {
      setBusy(false);
    }
  }

  async function removeBatch() {
    if (!window.confirm("Hapus seluruh batch ini?")) return;
    await api(`/api/batches/${batchId}`, { method: "DELETE" });
    router.push("/");
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-danger">{error}</p>
        <Button className="mt-4" variant="secondary" onClick={() => void load()}>Coba lagi</Button>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-muted">Memuat batch…</p>;

  const activePreview = preview?.[previewIndex] ?? null;
  const orderLines = orderNo ? data.lines.filter((line) => line.noPesanan === orderNo) : [];
  const orderSync = orderNo ? syncByOrder.get(orderNo) : undefined;

  return (
    <div className="pb-24">
      <Link href="/" className="text-sm text-muted hover:text-foreground">← Semua batch</Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{formatDay(data.batch.reportDate)}</h1>
          <p className="mt-1 text-sm text-muted">
            {data.batch.filename} · diunggah {formatDateTime(data.batch.createdAt)}
            {data.batch.createdBy ? ` oleh ${data.batch.createdBy}` : ""}. {data.batch.droppedCount} baris Pending/Paid/Canceled dibuang saat impor.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/api/batches/${batchId}/export`} className="inline-flex h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-[#f6f2e9]">Unduh Excel</a>
          <Button variant="secondary" onClick={() => void recalc()} disabled={busy}>Hitung ulang bobot</Button>
          <Button variant="secondary" onClick={() => void openPreview({})} disabled={busy}>Pratinjau batch</Button>
          <Button onClick={() => void openPreview({})} disabled={busy}>Sync ke Accurate</Button>
          <Button variant="ghost" onClick={() => void removeBatch()}>Hapus batch</Button>
        </div>
      </div>

      {banner ? <p className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">{banner}</p> : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Summary label="Hasil filter" value={`${filtered.length.toLocaleString("id-ID")} baris · ${totals.orders.toLocaleString("id-ID")} pesanan`} />
        <Summary label="Kotor" value={formatRp(totals.gross)} />
        <Summary label="Diskon / bersih" value={`${formatRp(totals.discount)} · ${formatRp(totals.gross - totals.discount)}`} />
        <Summary label="Bobot hilang" value={String(totals.missing)} warn={totals.missing > 0} />
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-5">
        <Input placeholder="Cari no pesanan, SKU, toko" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} />
        <Select label="Channel" value={channel} onChange={(value) => { setChannel(value); setPage(1); }} options={options.channels} />
        <Select label="Lokasi" value={lokasi} onChange={(value) => { setLokasi(value); setPage(1); }} options={options.lokasi} />
        <Select label="Status Jubelio" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={options.statuses} />
        <Select label="Status sinkron" value={sync} onChange={(value) => { setSync(value); setPage(1); }} options={["belum", "pratinjau", "gagal", "tersinkron"]} labels={SYNC_LABEL} />
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[1080px] text-left text-sm">
          <thead className="bg-[#f6f2e9] text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-10 px-3 py-3">
                <input type="checkbox" checked={allChecked} ref={(node) => { if (node) node.indeterminate = !allChecked && someChecked; }} onChange={toggleAll} aria-label="Pilih semua hasil filter" className="h-4 w-4 accent-[#0e6b4f]" />
              </th>
              <th className="px-3 py-3 font-medium">No Pesanan</th>
              <th className="px-3 py-3 font-medium">Channel</th>
              <th className="px-3 py-3 font-medium">SKU</th>
              <th className="px-3 py-3 font-medium">Qty</th>
              <th className="px-3 py-3 font-medium">Unit Price</th>
              <th className="px-3 py-3 font-medium">Total Diskon</th>
              <th className="px-3 py-3 font-medium">Lokasi</th>
              <th className="px-3 py-3 font-medium">Sinkron</th>
              <th className="px-3 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-10 text-center text-muted">Tidak ada baris untuk filter ini.</td></tr>
            ) : visible.map((line) => (
              <tr key={line.id} className="border-t border-border align-top">
                <td className="px-3 py-3">
                  <input type="checkbox" checked={selected.has(line.id)} onChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(line.id)) next.delete(line.id); else next.add(line.id); return next; })} aria-label={`Pilih ${line.noPesanan}`} className="h-4 w-4 accent-[#0e6b4f]" />
                </td>
                <td className="px-3 py-3">
                  <button className="text-left font-medium text-primary hover:underline" onClick={() => setOrderNo(line.noPesanan)}>{line.noPesanan}</button>
                  <div className="text-xs text-muted">{formatDateTime(line.tanggal)} · {line.namaToko || "—"}</div>
                </td>
                <td className="px-3 py-3">{line.channel}</td>
                <td className="px-3 py-3">
                  <div className="font-mono text-[13px]">{line.sku}</div>
                  {line.missingWeight ? <span className="mt-1 inline-block rounded bg-[#fff4d6] px-1.5 py-0.5 text-[11px] font-medium text-warning">Bobot hilang</span> : null}
                </td>
                <td className="px-3 py-3 tabular-nums">{qtyText(line.qty)}</td>
                <td className="px-3 py-3 tabular-nums">{formatRp(line.hargaJual)}</td>
                <td className="px-3 py-3 tabular-nums">{formatRp(line.totalDiskon)}</td>
                <td className="px-3 py-3">
                  <div>{line.lokasiGudang || "—"}</div>
                  <div className="text-xs text-muted">{line.status}</div>
                </td>
                <td className="px-3 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${syncTone[line.syncStatus]}`}>{SYNC_LABEL[line.syncStatus]}</span>
                </td>
                <td className="px-3 py-3 text-right">
                  <button className="text-sm text-primary hover:underline" onClick={() => setEditing(line)} disabled={line.syncStatus === "tersinkron"}>Ubah</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-muted">
        <span>Halaman {safePage} dari {pages}</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Sebelumnya</Button>
          <Button variant="secondary" size="sm" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Berikutnya</Button>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-sidebar px-4 py-3 text-white md:left-64">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <div className="text-sm">{selected.size} baris dipilih. Sync mengirim seluruh pesanan, bukan potongan baris.</div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void openPreview({ lineIds: [...selected] })} disabled={busy}>Pratinjau</Button>
              <Button size="sm" onClick={() => void openPreview({ lineIds: [...selected] })} disabled={busy}>Sync ke Accurate</Button>
              <Button variant="danger" size="sm" onClick={() => confirmDelete ? void removeSelected() : setConfirmDelete(true)} disabled={busy}>
                {confirmDelete ? "Ya, hapus" : "Hapus"}
              </Button>
              <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={() => { setSelected(new Set()); setConfirmDelete(false); }}>Batal</Button>
            </div>
          </div>
        </div>
      ) : null}

      {editing ? (
        <EditDialog
          line={editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            setBanner(message);
            await load();
          }}
        />
      ) : null}

      <Modal open={Boolean(orderNo)} onClose={() => setOrderNo(null)} title={orderNo || "Pesanan"} description="Satu pesanan menjadi satu faktur penjualan di Accurate." wide>
        {orderNo ? (
          <OrderBody
            lines={orderLines}
            sync={orderSync}
            busy={busy}
            onEdit={(line) => { setOrderNo(null); setEditing(line); }}
            onPreview={() => { setOrderNo(null); void openPreview({ orderNos: [orderNo] }); }}
            onDelete={async () => {
              const ids = orderLines.filter((line) => line.syncStatus !== "tersinkron").map((line) => line.id);
              if (!ids.length) return;
              await api("/api/lines/delete", { method: "POST", body: JSON.stringify({ ids }) });
              setOrderNo(null);
              await load();
            }}
            onReset={async () => {
              await api("/api/sync/reset", { method: "POST", body: JSON.stringify({ batchId, noPesanan: orderNo }) });
              setBanner("Status pesanan dikembalikan ke belum sinkron. Faktur di Accurate tidak dihapus.");
              await load();
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title="Payload Accurate"
        description="Isi persis yang dikirim sebagai application/x-www-form-urlencoded ke sales-invoice/save.do. Host dan session diisi saat kirim, dari open-db."
        wide
      >
        {preview && activePreview ? (
          <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
            <div className="max-h-[50vh] space-y-1 overflow-auto">
              {preview.map((item, index) => (
                <button key={item.noPesanan} onClick={() => setPreviewIndex(index)} className={`block w-full rounded-md px-2 py-2 text-left text-xs ${index === previewIndex ? "bg-[#e7f3ee]" : "hover:bg-[#f6f2e9]"}`}>
                  <div className="truncate font-medium">{item.noPesanan}</div>
                  <div className="text-muted">{item.skippedReason ? "Sudah tersinkron" : item.blockedReason ? "Diblokir" : "Siap"} · {item.lineCount} baris</div>
                </button>
              ))}
            </div>
            <div>
              <div className="text-sm">
                <span className="font-medium">{activePreview.customerName || "Pelanggan belum dipetakan"}</span>
                <span className="text-muted"> · kotor {formatRp(activePreview.gross)} · bersih {formatRp(activePreview.net)}</span>
              </div>
              {activePreview.blockedReason ? <p className="mt-2 rounded-md bg-[#fdecec] px-3 py-2 text-sm text-danger">{activePreview.blockedReason}</p> : null}
              {activePreview.skippedReason ? <p className="mt-2 rounded-md bg-[#e5f4ec] px-3 py-2 text-sm text-[#0e6b4f]">{activePreview.skippedReason}</p> : null}
              {activePreview.warnings.map((warning) => (
                <p key={warning} className="mt-2 rounded-md bg-[#fff8e8] px-3 py-2 text-sm text-[#6d4e00]">{warning}</p>
              ))}
              <p className="mt-3 font-mono text-xs text-muted">{activePreview.method} {activePreview.endpoint}</p>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-[#172033] p-3 font-mono text-xs leading-relaxed text-[#f4f0e6]">{activePreview.body.split("&").join("\n")}</pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => navigator.clipboard.writeText(activePreview.body)}>Salin body</Button>
                <Button onClick={() => void send()} disabled={busy}>
                  {busy ? "Mengirim…" : `Sync ke Accurate (${preview.filter((item) => !item.blockedReason && !item.skippedReason).length} siap)`}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted">Tanpa token Accurate, pengiriman ditolak dan status tidak menjadi tersinkron. Accurate unitPrice tetap harga per Qty baris. Shopee: Unit Price × Qty paket ÷ Qty. Selain Shopee: Unit Price ÷ Qty. itemCashDiscount = Total Diskon baris.</p>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function Summary({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${warn ? "text-warning" : ""}`}>{value}</div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  labels,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} className="h-9 rounded-md border border-border bg-white px-2 text-sm">
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option} value={option}>{labels?.[option] ?? option}</option>
      ))}
    </select>
  );
}

function EditDialog({ line, onClose, onSaved }: { line: SalesLine; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [form, setForm] = useState({
    noPesanan: line.noPesanan,
    channel: line.channel,
    sku: line.sku,
    qty: String(line.qty),
    hargaJual: line.hargaJual == null ? "" : String(line.hargaJual),
    totalDiskon: line.totalDiskon == null ? "" : String(line.totalDiskon),
    lokasiGudang: line.lokasiGudang ?? "",
    namaToko: line.namaToko ?? "",
    status: line.status ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const patch: LinePatch = {
      noPesanan: form.noPesanan,
      channel: form.channel,
      sku: form.sku,
      qty: Number(form.qty),
      hargaJual: Number(form.hargaJual),
      totalDiskon: Number(form.totalDiskon),
      lokasiGudang: form.lokasiGudang,
      namaToko: form.namaToko,
      status: form.status,
    };
    try {
      await api(`/api/lines/${line.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await onSaved("Baris disimpan.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan.");
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Ubah baris" description={line.namaBarang || undefined}>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="No Pesanan" value={form.noPesanan} onChange={(value) => setForm({ ...form, noPesanan: value })} />
        <Field label="Channel" value={form.channel} onChange={(value) => setForm({ ...form, channel: value })} />
        <Field label="SKU" value={form.sku} onChange={(value) => setForm({ ...form, sku: value })} />
        <Field label="Qty" value={form.qty} onChange={(value) => setForm({ ...form, qty: value })} />
        <Field label="Unit Price" value={form.hargaJual} onChange={(value) => setForm({ ...form, hargaJual: value })} />
        <Field label="Total Diskon" value={form.totalDiskon} onChange={(value) => setForm({ ...form, totalDiskon: value })} />
        <Field label="Lokasi gudang" value={form.lokasiGudang} onChange={(value) => setForm({ ...form, lokasiGudang: value })} />
        <Field label="Nama toko" value={form.namaToko} onChange={(value) => setForm({ ...form, namaToko: value })} />
        <Field label="Status Jubelio" value={form.status} onChange={(value) => setForm({ ...form, status: value })} />
        <div className="rounded-md bg-[#f6f2e9] px-3 py-2 text-xs leading-relaxed text-muted sm:col-span-2">
          SKU asal {line.sourceSku || "—"} · kunci bundle {line.bundleKey || "—"} · bobot {line.bobot == null ? "tidak ada" : formatDecimal(line.bobot)} · {line.isShopee ? "Unit Price Shopee per Qty paket asal" : "Unit Price non-Shopee = nilai kotor baris"}.
          No pesanan asal {line.noPesananSumber || "—"}. Hitung ulang dari tombol batch menimpa harga dan qty dengan angka asal.
        </div>
        {error ? <p className="text-sm text-danger sm:col-span-2">{error}</p> : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={busy}>{busy ? "Menyimpan…" : "Simpan"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function OrderBody({
  lines,
  sync,
  busy,
  onEdit,
  onPreview,
  onDelete,
  onReset,
}: {
  lines: SalesLine[];
  sync?: OrderSync;
  busy: boolean;
  onEdit: (line: SalesLine) => void;
  onPreview: () => void;
  onDelete: () => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const gross = lines.reduce((sum, line) => sum + lineAmount(line), 0);
  const discount = lines.reduce((sum, line) => sum + (line.totalDiskon ?? 0), 0);
  const locked = lines.some((line) => line.syncStatus === "tersinkron");
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${syncTone[lines[0]?.syncStatus ?? "belum"]}`}>{SYNC_LABEL[lines[0]?.syncStatus ?? "belum"]}</span>
        <span className="text-muted">{lines[0]?.channel} · {lines[0]?.namaToko || "—"} · {lines[0]?.lokasiGudang || "—"}</span>
      </div>
      {sync?.accurateNumber ? <p className="mt-2 text-sm">Nomor Accurate: <span className="font-medium">{sync.accurateNumber}</span></p> : null}
      {sync?.error ? <p className="mt-2 text-sm text-danger">{sync.error}</p> : null}
      <p className="mt-2 text-sm tabular-nums">Kotor {formatRp(gross)} · diskon {formatRp(discount)} · bersih {formatRp(gross - discount)}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted">
            <tr>
              <th className="py-2">SKU</th>
              <th>Qty</th>
              <th>Unit Price</th>
              <th>Diskon</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-border">
                <td className="py-2 font-mono text-[13px]">{line.sku}{line.missingWeight ? " · bobot hilang" : ""}</td>
                <td className="tabular-nums">{qtyText(line.qty)}</td>
                <td className="tabular-nums">{formatRp(line.hargaJual)}</td>
                <td className="tabular-nums">{formatRp(line.totalDiskon)}</td>
                <td className="text-right">{locked ? null : <button className="text-primary" onClick={() => onEdit(line)}>Ubah</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onPreview} disabled={busy}>Pratinjau / Sync</Button>
        {locked || lines[0]?.syncStatus === "gagal" ? (
          <Button variant="secondary" onClick={() => void onReset()} disabled={busy}>Tandai belum sinkron</Button>
        ) : null}
        <Button variant="danger" onClick={() => void onDelete()} disabled={busy || locked}>Hapus pesanan</Button>
      </div>
      {locked ? <p className="mt-2 text-xs text-muted">Menandai belum sinkron tidak menghapus faktur yang sudah masuk Accurate. Pakai hanya jika catatan sinkronnya keliru.</p> : null}
    </div>
  );
}
