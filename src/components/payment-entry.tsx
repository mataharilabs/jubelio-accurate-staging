"use client";

import { useEffect, useState } from "react";
import { ActionButton, reported, reportedOk, TableShell } from "@/components/ui/feedback";
import { Pager, usePageSize } from "@/components/ui/pager";
import { api, track } from "@/lib/api-client";
import { canMaintainMaster } from "@/lib/auth/permissions";
import { rp } from "@/lib/format";

type Lookup = {
  found: boolean;
  channel?: string;
  storeName?: string;
  net?: number;
  cancelled?: boolean;
  paidVia?: "settlement" | "manual" | null;
  unpaid?: boolean;
};

type PaymentRow = {
  id: string;
  noPesanan: string;
  channel: string;
  storeName: string;
  net: number;
  amountRp: number;
  diff: number;
  paidAt: string;
  method: string;
  note: string;
  createdBy: string;
};

type Page = { total: number; page: number; pages: number; rows: PaymentRow[] };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function statusText(lookup: Lookup | null): string {
  if (!lookup?.found) return "";
  if (lookup.cancelled) return "Dibatalkan";
  if (lookup.paidVia === "settlement") return "Sudah ada settlement";
  if (lookup.paidVia === "manual") return "Sudah lunas (manual)";
  if (lookup.unpaid) return "Belum ada pembayaran";
  if ((lookup.net ?? 0) === 0) return "Lunas (revenue nol)";
  return "";
}

export function PaymentEntry() {
  const [canWrite, setCanWrite] = useState(false);
  const [noPesanan, setNoPesanan] = useState("");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [paidAt, setPaidAt] = useState(today());
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize, ready] = usePageSize("order-payments", 25);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PaymentRow | null>(null);

  async function load(nextPage = page, nextQ = q, nextLimit = pageSize) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: String(nextLimit), q: nextQ });
      setData(await api<Page>(`/api/fees/payments?${params}`));
      setError(null);
    } catch (err) {
      setError(reported(err, "Gagal memuat pembayaran."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api<{ role?: string; permissions?: string[] }>("/api/auth/me").then((me) => {
      setCanWrite(canMaintainMaster(me.role ?? "", me.permissions ?? [], "fees.manage"));
    }).catch(() => setCanWrite(false));
  }, []);

  useEffect(() => {
    if (!ready) return;
    load(0, q, pageSize).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function checkOrder(value = noPesanan) {
    const key = value.trim();
    if (!key) {
      setLookup(null);
      return;
    }
    const result = await api<Lookup>(`/api/fees/payments?noPesanan=${encodeURIComponent(key)}`);
    setLookup(result);
    if (result.found && result.net != null && amount === "") setAmount(String(result.net));
  }

  async function save() {
    if (!lookup?.found || lookup.cancelled) throw new Error("Nomor pesanan tidak bisa dicatat pembayarannya.");
    const nominal = Number(amount);
    if (!Number.isFinite(nominal)) throw new Error("Isi nominal.");
    await api("/api/fees/payments", {
      method: "POST",
      body: JSON.stringify({
        source: "manual",
        rows: [{ noPesanan: noPesanan.trim(), paidAt, amountRp: nominal, method, note }],
      }),
    });
    setNoPesanan("");
    setLookup(null);
    setAmount("");
    setMethod("");
    setNote("");
    reportedOk("Pembayaran disimpan.");
    await load(0);
  }

  async function remove(row: PaymentRow) {
    await api("/api/fees/payments", { method: "DELETE", body: JSON.stringify({ ids: [row.id] }) });
    setRemoving(null);
    reportedOk("Pembayaran dihapus. Pesanan kembali belum lunas bila revenue-nya bukan nol.");
    await load();
  }

  const rows = data?.rows ?? [];

  return (
    <div className="card mt">
      <h3>Catat pembayaran</h3>
      <p className="small mut">Untuk pesanan di luar marketplace, atau pesanan mana pun yang tidak punya file settlement. Nominal yang dicatat bukan biaya dan tidak mengurangi profit. Menyimpan lagi untuk pesanan yang sama mengganti catatan sebelumnya.</p>
      {error ? <div className="warnbox">{error}</div> : null}
      {canWrite ? (
        <div className="grid g2 mt">
          <div className="f"><label>No pesanan</label>
            <input value={noPesanan} onChange={(event) => setNoPesanan(event.target.value)} onBlur={() => checkOrder().catch((err: Error) => setError(reported(err)))} />
            {lookup ? <div className="small mut">{lookup.found ? `${lookup.channel || "—"} · ${lookup.storeName || "—"} · revenue ${rp(lookup.net ?? 0)} · ${statusText(lookup)}` : "Tidak ditemukan"}</div> : null}
          </div>
          <div className="f"><label>Tanggal bayar</label><input type="date" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} /></div>
          <div className="f"><label>Nominal</label><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
          <div className="f"><label>Metode</label><input value={method} onChange={(event) => setMethod(event.target.value)} placeholder="Transfer, tunai, …" /></div>
          <div className="f"><label>Catatan</label><input value={note} onChange={(event) => setNote(event.target.value)} /></div>
          <div className="f"><label>&nbsp;</label>
            <ActionButton className="btn pri" onClick={() => save().catch((err: Error) => setError(reported(err, "Gagal menyimpan.")))}>Tambah pembayaran</ActionButton>
          </div>
        </div>
      ) : <p className="small mut">Mencatat pembayaran hanya untuk yang punya izin kelola biaya.</p>}
      <div className="filterbar">
        <div className="f grow"><label>Cari</label>
          <input value={q} placeholder="No pesanan, channel, toko" onKeyDown={(event) => { if (event.key === "Enter") { setPage(0); load(0, q).catch(() => undefined); } }} onChange={(event) => setQ(event.target.value)} />
        </div>
        <div className="f"><label>&nbsp;</label><button className="btn" onClick={() => { setPage(0); load(0, q).catch((err: Error) => setError(reported(err))); }}>Cari</button></div>
        <div className="f"><label>&nbsp;</label>
          <ActionButton className="btn" onClick={async () => {
            const response = await track(fetch(`/api/fees/payments/export?q=${encodeURIComponent(q)}`));
            if (!response.ok) {
              const payload = await response.json().catch(() => ({ error: "Gagal mengunduh." }));
              throw new Error(payload.error || "Gagal mengunduh.");
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "pembayaran-dicatat.xlsx";
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
            reportedOk("Excel diunduh.");
          }}>Excel</ActionButton>
        </div>
      </div>
      <TableShell loading={loading}>
        <div className="tscroll">
          <table className="small cards">
            <thead><tr><th>No pesanan</th><th>Channel</th><th>Toko</th><th className="n">Revenue</th><th className="n">Nominal</th><th className="n">Selisih</th><th>Tanggal</th><th>Metode</th><th>Catatan</th><th>Oleh</th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="No pesanan">{row.noPesanan}</td>
                  <td data-label="Channel">{row.channel || "—"}</td>
                  <td data-label="Toko">{row.storeName || "—"}</td>
                  <td data-label="Revenue" className="n">{rp(row.net)}</td>
                  <td data-label="Nominal" className="n">{rp(row.amountRp)}</td>
                  <td data-label="Selisih" className="n">{rp(row.diff)}</td>
                  <td data-label="Tanggal">{row.paidAt}</td>
                  <td data-label="Metode">{row.method || "—"}</td>
                  <td data-label="Catatan">{row.note || "—"}</td>
                  <td data-label="Oleh">{row.createdBy || "—"}</td>
                  <td>{canWrite ? <button className="btn sm danger" onClick={() => setRemoving(row)}>Hapus</button> : null}</td>
                </tr>
              ))}
              {!rows.length && !loading ? <tr><td colSpan={11} className="mut">Belum ada pembayaran tercatat</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager page={data?.page ?? page} pageSize={pageSize} total={data?.total ?? 0} shown={rows.length} onPage={(next) => { setPage(next); load(next).catch(() => undefined); }} onPageSize={(next) => { setPageSize(next); setPage(0); load(0, q, next).catch(() => undefined); }} />
      </TableShell>
      {removing ? (
        <div className="modal-bg on"><div className="modal">
          <h2>Hapus pembayaran</h2>
          <p>Hapus catatan {removing.noPesanan}? Pesanan menjadi belum lunas bila revenue-nya bukan nol dan tidak ada settlement.</p>
          <div className="actions">
            <button className="btn" onClick={() => setRemoving(null)}>Batal</button>
            <ActionButton className="btn danger" onClick={() => remove(removing).catch((err: Error) => setError(reported(err)))}>Hapus</ActionButton>
          </div>
        </div></div>
      ) : null}
    </div>
  );
}
