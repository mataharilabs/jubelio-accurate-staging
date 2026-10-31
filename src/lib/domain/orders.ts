import { customerCode, recomputeLines, type CleanLine } from "@/lib/cleanup/rapikan";
import type { FieldChange, OrderLine, OrderVersion, ReviewItem, SyncCategory } from "@/lib/db/types";

const MONEY_EPS = 0.5;

export function moneyChanged(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > MONEY_EPS;
}

function nstr(value: number | null | undefined): string | null {
  if (value == null || Number.isNaN(value)) return null;
  return String(Math.round(value * 1e6) / 1e6);
}

function lineBySku(lines: OrderLine[]): Map<string, OrderLine> {
  const map = new Map<string, OrderLine>();
  for (const line of lines) map.set(line.sku, line);
  return map;
}

export function orderRevenue(lines: OrderLine[]): number | null {
  if (lines.some((line) => line.revenuePerUnit == null)) return null;
  return lines.reduce((sum, line) => sum + (line.revenuePerUnit ?? 0) * line.qty, 0);
}

export function versionFromCleanLines(
  lines: CleanLine[],
  input: { id: string; versionNo: number; importId: string | null; source: OrderVersion["source"]; createdAt: string; createdBy: string | null },
): OrderVersion {
  const first = lines[0];
  const status = lines.some((line) => line.status.toUpperCase() === "RETURNED")
    ? (lines.find((line) => line.status.toUpperCase() === "RETURNED")?.status ?? "RETURNED")
    : (first?.status ?? "");
  const orderLines: OrderLine[] = lines.map((line) => ({
    id: crypto.randomUUID(),
    sku: line.sku,
    productName: line.productName,
    qty: line.qty,
    unitPrice: line.unitPrice,
    subTotal: line.subTotal,
    unitDiskon: line.unitDiskon,
    revenuePerUnit: line.revenuePerUnit,
    missingWeight: line.missingWeight,
    bundleKey: line.bundleKey,
    unitCogs: null,
    flags: line.flags,
  }));
  return {
    id: input.id,
    noPesanan: first?.noPesanan ?? "",
    versionNo: input.versionNo,
    importId: input.importId,
    source: input.source,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    isCurrent: true,
    tanggal: first?.tanggal ?? "",
    day: first?.day ?? "",
    channel: first?.channel ?? "",
    storeName: first?.storeName ?? "",
    customerName: first?.customerName ?? "",
    customerCode: first?.customerCode || customerCode(first?.customerName),
    province: first?.province ?? "",
    city: first?.city ?? "",
    kurir: first?.kurir ?? "",
    status,
    lokasiGudang: lines.find((line) => line.lokasiGudang)?.lokasiGudang ?? null,
    totalNilaiPesanan: first?.totalNilaiPesanan ?? null,
    totalDiskon: first?.totalDiskon ?? 0,
    qty: orderLines.reduce((sum, line) => sum + line.qty, 0),
    revenue: orderRevenue(orderLines),
    lines: orderLines,
  };
}

export function diffVersions(previous: OrderVersion | null, next: OrderVersion): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (field: string, kind: FieldChange["kind"], oldValue: string | null, newValue: string | null) => {
    changes.push({
      id: crypto.randomUUID(),
      noPesanan: next.noPesanan,
      fromVersionId: previous?.id ?? null,
      toVersionId: next.id,
      field,
      kind,
      oldValue,
      newValue,
    });
  };
  const headerFields: [string, string | null, string | null, boolean][] = [
    ["status", previous?.status ?? null, next.status, false],
    ["channel", previous?.channel ?? null, next.channel, false],
    ["storeName", previous?.storeName ?? null, next.storeName, false],
    ["customerName", previous?.customerName ?? null, next.customerName, false],
    ["province", previous?.province ?? null, next.province, false],
    ["city", previous?.city ?? null, next.city, false],
    ["kurir", previous?.kurir ?? null, next.kurir, false],
    ["tanggal", previous?.tanggal ?? null, next.tanggal, false],
    ["lokasiGudang", previous?.lokasiGudang ?? null, next.lokasiGudang, false],
    ["totalNilaiPesanan", nstr(previous?.totalNilaiPesanan), nstr(next.totalNilaiPesanan), true],
    ["totalDiskon", nstr(previous?.totalDiskon), nstr(next.totalDiskon), true],
    ["qty", previous ? String(previous.qty) : null, String(next.qty), false],
    ["revenue", nstr(previous?.revenue), nstr(next.revenue), true],
  ];
  if (previous) {
    for (const [field, oldValue, newValue, money] of headerFields) {
      const differ = money ? moneyChanged(oldValue == null ? null : Number(oldValue), newValue == null ? null : Number(newValue)) : oldValue !== newValue;
      if (differ) push(`header.${field}`, "changed", oldValue, newValue);
    }
  }
  const before = lineBySku(previous?.lines ?? []);
  const after = lineBySku(next.lines);
  for (const [sku, line] of after) {
    const prev = before.get(sku);
    if (!prev) {
      push(`line.${sku}`, "added", null, `${line.qty} x ${nstr(line.unitPrice)}`);
      continue;
    }
    if (prev.qty !== line.qty) push(`line.${sku}.qty`, "changed", String(prev.qty), String(line.qty));
    if (moneyChanged(prev.unitPrice, line.unitPrice)) push(`line.${sku}.unitPrice`, "changed", nstr(prev.unitPrice), nstr(line.unitPrice));
    if (moneyChanged(prev.unitDiskon, line.unitDiskon)) push(`line.${sku}.unitDiskon`, "changed", nstr(prev.unitDiskon), nstr(line.unitDiskon));
    if (moneyChanged(prev.subTotal, line.subTotal)) push(`line.${sku}.subTotal`, "changed", nstr(prev.subTotal), nstr(line.subTotal));
    if (moneyChanged(prev.revenuePerUnit, line.revenuePerUnit)) push(`line.${sku}.revenuePerUnit`, "changed", nstr(prev.revenuePerUnit), nstr(line.revenuePerUnit));
  }
  for (const [sku, line] of before) {
    if (!after.has(sku)) push(`line.${sku}`, "removed", `${line.qty} x ${nstr(line.unitPrice)}`, null);
  }
  return changes;
}

function dataChanged(changes: FieldChange[]): boolean {
  return changes.some((change) => change.field !== "header.status");
}

function isCancelStatus(status: string | null | undefined): boolean {
  const value = (status ?? "").toUpperCase();
  return value === "CANCELED" || value === "CANCELLED" || value === "CANCEL";
}

export function classifyOrder(current: OrderVersion | null, synced: OrderVersion | null): SyncCategory | null {
  const everSynced = Boolean(synced);
  if (!current || current.source === "cancel" || current.source === "manual_delete" || isCancelStatus(current.status)) {
    return everSynced ? "Batal" : null;
  }
  if (!everSynced || !synced) return "Baru";
  const changes = diffVersions(synced, current);
  if (!changes.length) return "Sama";
  const statusChanged = changes.some((change) => change.field === "header.status");
  const becameReturned = current.status.toUpperCase() === "RETURNED" && synced.status.toUpperCase() !== "RETURNED";
  if (becameReturned) return "Returned";
  if (dataChanged(changes)) return "Berubah";
  if (statusChanged) return "Status saja";
  return "Sama";
}

export function needsConfirmation(category: SyncCategory | null): boolean {
  return category === "Berubah" || category === "Returned" || category === "Batal";
}

export function preselected(category: SyncCategory | null): boolean {
  return category === "Baru" || category === "Berubah" || category === "Batal" || category === "Returned";
}

export function canSync(category: SyncCategory | null, decision: "confirmed" | "ignored" | null, decisionVersionId: string | null, currentVersionId: string): boolean {
  if (category === "Baru") return true;
  if (!needsConfirmation(category)) return false;
  return decision === "confirmed" && decisionVersionId === currentVersionId;
}

export function summaryOf(category: SyncCategory, changes: FieldChange[]): string {
  if (category === "Baru") return "Pesanan baru, belum pernah disync";
  if (category === "Batal") return "Dibatalkan setelah tersinkron — invoice di Accurate perlu dihapus";
  if (category === "Returned") return "Status menjadi RETURNED — perlu disync ulang";
  if (category === "Status saja") return "Hanya status Jubelio yang berubah — diperbarui di web, tidak disync";
  if (category === "Sama") return "Tidak ada perubahan";
  const labels = [...new Set(changes.filter((change) => change.field !== "header.status").map((change) => change.field.split(".")[0] === "line" ? `SKU ${change.field.split(".")[1]}` : change.field.replace("header.", "")))];
  return labels.slice(0, 4).join(", ") || "Nilai berubah";
}

export function applyLineEdit(
  version: OrderVersion,
  lineId: string,
  patch: { sku?: string; qty?: number; unitPrice?: number; city?: string },
): OrderLine[] {
  const lines = version.lines.map((line) => {
    if (line.id !== lineId) return { ...line };
    return {
      ...line,
      sku: patch.sku != null && patch.sku.trim() ? patch.sku.trim() : line.sku,
      qty: patch.qty != null ? patch.qty : line.qty,
      unitPrice: patch.unitPrice != null ? patch.unitPrice : line.unitPrice,
    };
  });
  return recomputeLines(lines, version.totalDiskon).map((line) => ({
    ...line,
    id: line.id,
  }));
}

export function reviewsFromLines(lines: CleanLine[]): Omit<ReviewItem, "id" | "status">[] {
  const items: Omit<ReviewItem, "id" | "status">[] = [];
  const seen = new Set<string>();
  const add = (kind: ReviewItem["kind"], rawKey: string, detail: Record<string, string>) => {
    const key = `${kind}:${rawKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, rawKey, detail });
  };
  for (const line of lines) {
    if (line.flags.includes("channel")) add("channel_store", `${line.channel}\u0000${line.storeName}`, { channel: line.channel, store: line.storeName });
    if (line.flags.includes("provinsi")) add("province", line.province, { province: line.province });
    if (line.flags.includes("kota")) add("city", `${line.province}\u0000${line.city}`, { province: line.province, city: line.city });
    if (line.missingWeight && line.bundleKey) add("bobot", line.bundleKey, { bundleKey: line.bundleKey, sku: line.sku });
  }
  return items;
}

export function groupCleanLines(lines: CleanLine[]): CleanLine[][] {
  const map = new Map<string, CleanLine[]>();
  for (const line of lines) {
    const list = map.get(line.noPesanan);
    if (list) list.push(line);
    else map.set(line.noPesanan, [line]);
  }
  return [...map.values()];
}
