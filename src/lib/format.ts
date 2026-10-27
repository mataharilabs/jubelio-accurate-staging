import type { SyncStatus } from "@/lib/db/types";

export const SYNC_LABEL: Record<SyncStatus, string> = {
  belum: "Belum sinkron",
  pratinjau: "Pratinjau",
  tersinkron: "Tersinkron",
  gagal: "Gagal",
};

export function formatRp(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatDecimal(value: number, places = 6): string {
  if (!Number.isFinite(value)) return "0";
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  const text = rounded.toFixed(places).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

export function formatDay(day: string | null | undefined): string {
  if (!day) return "—";
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  // SheetJS reads Excel wall-clock times as UTC. Jubelio already stores local time,
  // so formatting in UTC keeps the clock and the calendar day from the file.
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function accurateDate(iso: string | null | undefined, fallbackDay: string): string {
  if (iso) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).formatToParts(date);
      const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
      return `${pick("day")}/${pick("month")}/${pick("year")}`;
    }
  }
  const [year, month, day] = fallbackDay.split("-");
  if (year && month && day) return `${day}/${month}/${year}`;
  return fallbackDay;
}
