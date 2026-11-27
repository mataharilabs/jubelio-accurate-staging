"use client";

import { useState } from "react";
import { ActionButton, reported, reportedOk, Spinner, TableShell } from "@/components/ui/feedback";
import { api, track } from "@/lib/api-client";
import { chunkFeeRows, chunkPayments, keepMatched } from "@/lib/fees/chunk";
import { parseFeeWorkbook, summarizeFees } from "@/lib/fees/parse";
import type { FeeDraft, FeeGroup, Marketplace, ParsedFees, PaymentDraft } from "@/lib/fees/types";
import { FEE_GROUPS } from "@/lib/fees/types";
import { rp } from "@/lib/format";

const MARKET_LABEL: Record<Marketplace, string> = {
  shopee: "Shopee",
  lazada: "Lazada",
  tiktok: "TikTok & Tokopedia",
  blibli: "Blibli",
  template: "Template standar",
};

type MatchResult = { matched: { input: string; resolved: string }[]; missing: string[] };
type Preview = {
  parsed: ParsedFees;
  matchedRows: FeeDraft[];
  matchedPayments: PaymentDraft[];
  missing: string[];
};

function keepPayments(rows: readonly PaymentDraft[], matched: readonly { input: string; resolved: string }[]): PaymentDraft[] {
  const resolved = new Map(matched.map((item) => [item.input, item.resolved]));
  return rows.flatMap((row) => {
    const next = resolved.get(row.noPesanan);
    if (!next) return [];
    return [next === row.noPesanan ? row : { ...row, noPesanan: next }];
  });
}

async function saveBlob(response: Response, filename: string) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Gagal mengunduh." }));
    throw new Error(payload.error || "Gagal mengunduh.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function groupAmount(rows: FeeDraft[], group: FeeGroup): number {
  return rows.filter((row) => row.feeGroup === group && Math.abs(row.amountRp) >= 0.005).reduce((sum, row) => sum + row.amountRp, 0);
}

export function PembayaranView() {
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function onFile(file: File) {
    setError(null);
    setSaved(null);
    setPreview(null);
    setFileName(file.name);
    setPhase("Membaca file…");
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const parsed = parseFeeWorkbook(book);
      setPhase("Mencocokkan pesanan…");
      const keys = parsed.orders.map((order) => ({ noPesanan: order.noPesanan, orderId: order.orderId }));
      const matched: MatchResult["matched"] = [];
      const missing: string[] = [];
      for (let index = 0; index < keys.length; index += 4000) {
        const part = await api<MatchResult>("/api/fees/match", {
          method: "POST",
          body: JSON.stringify({ keys: keys.slice(index, index + 4000) }),
        });
        matched.push(...part.matched);
        missing.push(...part.missing);
      }
      setPreview({
        parsed,
        matchedRows: keepMatched(parsed.rows, matched),
        matchedPayments: keepPayments(parsed.payments ?? [], matched),
        missing,
      });
    } catch (err) {
      setError(reported(err, "Gagal membaca file."));
    } finally {
      setPhase(null);
    }
  }

  async function save() {
    if (!preview) return;
    const rows = preview.matchedRows;
    const payments = preview.matchedPayments;
    if (!rows.length && !payments.length) {
      setError(reported(new Error("Tidak ada pesanan yang cocok untuk disimpan.")));
      return;
    }
    setError(null);
    setSaved(null);
    const importId = crypto.randomUUID();
    let inserted = 0;
    let replaced = 0;
    let paid = 0;
    try {
      const chunks = chunkFeeRows(rows);
      for (let index = 0; index < chunks.length; index += 1) {
        setPhase(`Menyimpan biaya ${index + 1}/${chunks.length}…`);
        const result = await api<{ inserted: number; replaced: number }>("/api/fees/commit", {
          method: "POST",
          body: JSON.stringify({
            importId,
            marketplace: preview.parsed.marketplace,
            format: preview.parsed.format,
            fileName,
            allocate: preview.parsed.marketplace === "tiktok",
            matchedOrders: new Set(rows.map((row) => row.noPesanan)).size,
            unmatchedOrders: preview.missing.length,
            rows: chunks[index],
          }),
        });
        inserted += result.inserted;
        replaced += result.replaced;
      }
      const payChunks = chunkPayments(payments);
      for (let index = 0; index < payChunks.length; index += 1) {
        setPhase(`Menyimpan pembayaran ${index + 1}/${payChunks.length}…`);
        const result = await api<{ inserted: number }>("/api/fees/payments", {
          method: "POST",
          body: JSON.stringify({ source: "template", importId, rows: payChunks[index] }),
        });
        paid += result.inserted;
      }
      setSaved(reportedOk(`Tersimpan ${inserted} baris biaya dan ${paid} pembayaran.${replaced ? ` ${replaced} baris biaya lama diganti.` : ""} Pesanan yang tidak ditemukan tidak disimpan.`));
      setPreview(null);
    } catch (err) {
      setError(reported(err, "Gagal menyimpan biaya."));
    } finally {
      setPhase(null);
    }
  }

  const summary = preview ? summarizeFees(preview.matchedRows) : null;
  const sample = preview?.matchedRows.filter((row) => Math.abs(row.amountRp) >= 0.005).slice(0, 12) ?? [];

  return (
    <div>
      {error ? <div className="warnbox">{error}</div> : null}
      {saved ? <div className="note mt">{saved}</div> : null}
      <div className="pagehead">
        <div className="desc">
          Unggah laporan penarikan dana. Biaya disimpan per pesanan, lalu profit = revenue bersih − HPP (DPP × 1,11) − biaya yang mengurangi profit. Pajak tidak mengurangi profit. Mengunggah ulang marketplace yang sama untuk pesanan yang sama menggantikan biaya sebelumnya.
        </div>
        <div className="actions">
          <ActionButton className="btn" onClick={async () => { const response = await track(fetch("/api/fees/template")); await saveBlob(response, "template-biaya-marketplace.xlsx"); reportedOk("Template diunduh."); }}>Unduh template.xlsx</ActionButton>
        </div>
      </div>
      <div className="card">
        <div className="f">
          <label>File Excel</label>
          <input
            type="file"
            accept=".xlsx,.xls"
            aria-label="File biaya marketplace"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onFile(file).catch((err: Error) => setError(reported(err)));
            }}
          />
        </div>
        <p className="small mut">Shopee Laporan Penghasilan, Lazada Transaction Overview, TikTok/Tokopedia Detail pesanan, Blibli SSR, atau template. File besar dibaca di browser, lalu dicocokkan ke No Pesanan. Biaya TikTok per pesanan dibagi ke SKU menurut porsi penjualan saat disimpan.</p>
        {phase ? <div className="table-loading" role="status"><Spinner /> {phase}</div> : null}
      </div>
      {preview && summary ? (
        <div className="card mt">
          <h3>{fileName} <small>{MARKET_LABEL[preview.parsed.marketplace]}</small></h3>
          <div className="grid g3 mt">
            <div><div className="mut small">Pesanan di file</div><b>{preview.parsed.orders.length}</b></div>
            <div><div className="mut small">Cocok</div><b>{preview.parsed.orders.length - preview.missing.length}</b></div>
            <div><div className="mut small">Tidak ditemukan</div><b>{preview.missing.length}</b></div>
            <div><div className="mut small">Total biaya tersimpan</div><b>{rp(summary.total)}</b></div>
            <div><div className="mut small">Pembayaran cocok</div><b>{preview.matchedPayments.length}</b> · {rp(preview.matchedPayments.reduce((sum, row) => sum + row.amountRp, 0))}</div>
          </div>
          <div className="tscroll mt">
            <table className="small cards">
              <thead><tr><th>Grup biaya</th><th className="n">Baris</th><th className="n">Nominal</th></tr></thead>
              <tbody>
                {FEE_GROUPS.map((group) => {
                  const amount = groupAmount(preview.matchedRows, group);
                  const count = preview.matchedRows.filter((row) => row.feeGroup === group && Math.abs(row.amountRp) >= 0.005).length;
                  if (!count) return null;
                  return (
                    <tr key={group}>
                      <td data-label="Grup">{group}{group === "Pajak" ? <div className="mut">tidak mengurangi profit</div> : null}</td>
                      <td data-label="Baris" className="n">{count}</td>
                      <td data-label="Nominal" className="n">{rp(amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h3 className="mt">Contoh baris</h3>
          <TableShell>
            <div className="tscroll">
              <table className="small cards">
                <thead><tr><th>No pesanan</th><th>SKU</th><th>Grup</th><th>Nama</th><th className="n">Nominal</th></tr></thead>
                <tbody>
                  {sample.map((row, index) => (
                    <tr key={`${row.noPesanan}-${row.feeName}-${index}`}>
                      <td data-label="No pesanan">{row.noPesanan}</td>
                      <td data-label="SKU">{row.sku || "—"}{row.allocated ? <div className="mut">dialokasikan</div> : null}</td>
                      <td data-label="Grup">{row.feeGroup}</td>
                      <td data-label="Nama">{row.feeName}</td>
                      <td data-label="Nominal" className="n">{rp(row.amountRp)}</td>
                    </tr>
                  ))}
                  {!sample.length ? <tr><td colSpan={5} className="mut">Tidak ada biaya selain penanda settlement.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </TableShell>
          {preview.missing.length ? (
            <div className="mt">
              <b>Tidak ditemukan ({preview.missing.length})</b>
              <p className="small mut">Nomor ini tidak ada di pesanan aktif. Barisnya tidak disimpan.</p>
              <div className="tscroll" style={{ maxHeight: 220 }}>
                <ul>
                  {preview.missing.slice(0, 200).map((id) => <li key={id}>{id}</li>)}
                </ul>
              </div>
              {preview.missing.length > 200 ? <p className="small mut">Menampilkan 200 dari {preview.missing.length}.</p> : null}
            </div>
          ) : null}
          <div className="actions mt">
            <ActionButton className="btn pri" disabled={Boolean(phase) || (!preview.matchedRows.length && !preview.matchedPayments.length)} onClick={() => save()}>Simpan</ActionButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
