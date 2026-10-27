import { lineAmount, recomputeAmounts } from "@/lib/cleanup/rapikan";
import { AppError } from "@/lib/errors";
import type { Batch, LinePatch, SalesLine } from "@/lib/db/types";

export function aggregateBatch(batch: Batch, lines: SalesLine[]): Batch {
  const orders = new Map<string, SalesLine["syncStatus"]>();
  let gross = 0;
  let discount = 0;
  let missing = 0;
  for (const line of lines) {
    gross += lineAmount(line);
    if (line.totalDiskon != null) discount += line.totalDiskon;
    if (line.missingWeight) missing += 1;
    if (!orders.has(line.noPesanan)) orders.set(line.noPesanan, line.syncStatus);
  }
  return {
    ...batch,
    rowCount: lines.length,
    missingWeightCount: missing,
    grossTotal: gross,
    discountTotal: discount,
    orderCount: orders.size,
    unsyncedCount: [...orders.values()].filter((status) => status !== "tersinkron").length,
  };
}

export function applyLinePatch(line: SalesLine, patch: LinePatch, siblings: SalesLine[]): SalesLine {
  if (line.syncStatus === "tersinkron") {
    throw new AppError("Pesanan ini sudah tersinkron dan tidak bisa diubah.");
  }
  const next: SalesLine = { ...line };
  if (patch.noPesanan != null) {
    const noPesanan = patch.noPesanan.trim();
    if (!noPesanan) throw new AppError("Nomor pesanan tidak boleh kosong.");
    const destination = siblings.find((row) => row.id !== line.id && row.noPesanan === noPesanan);
    if (destination?.syncStatus === "tersinkron") {
      throw new AppError("Pesanan tujuan sudah tersinkron.");
    }
    next.noPesanan = noPesanan;
    if (destination) next.syncStatus = destination.syncStatus;
    else if (noPesanan !== line.noPesanan) next.syncStatus = "belum";
  }
  if (patch.channel != null) next.channel = patch.channel.trim();
  if (patch.sku != null) {
    const sku = patch.sku.trim();
    if (!sku) throw new AppError("SKU tidak boleh kosong.");
    next.sku = sku;
  }
  if (patch.qty != null) {
    if (!Number.isFinite(patch.qty) || patch.qty <= 0) throw new AppError("Qty harus lebih dari 0.");
    next.qty = patch.qty;
  }
  if (patch.hargaJual != null) {
    if (!Number.isFinite(patch.hargaJual)) throw new AppError("Unit Price tidak valid.");
    next.hargaJual = patch.hargaJual;
  }
  if (patch.totalDiskon != null) {
    if (!Number.isFinite(patch.totalDiskon)) throw new AppError("Total diskon tidak valid.");
    next.totalDiskon = patch.totalDiskon;
  }
  if (patch.lokasiGudang !== undefined) next.lokasiGudang = patch.lokasiGudang?.trim() || null;
  if (patch.namaToko !== undefined) next.namaToko = patch.namaToko?.trim() || null;
  if (patch.status !== undefined) next.status = patch.status?.trim() || null;
  if (next.hargaJual != null && next.totalDiskon != null) next.missingWeight = false;
  return next;
}

export function withWeights(line: SalesLine, weights: Map<string, number>): SalesLine {
  return { ...line, ...recomputeAmounts(line, weights) };
}
