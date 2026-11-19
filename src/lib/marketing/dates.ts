const SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const FULL = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

export function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (stamp.getUTCFullYear() !== year || stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const epoch = Date.UTC(1899, 11, 30);
    const stamp = new Date(epoch + Math.round(value) * 86400000);
    return isoDate(stamp.getUTCFullYear(), stamp.getUTCMonth() + 1, stamp.getUTCDate());
  }
  const text = String(value ?? "").trim();
  if (!text || text === "-" || text === "—") return null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (dmy) return isoDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  return null;
}

export function parseDateRange(value: unknown): { start: string; end: string } | null {
  const text = String(value ?? "").trim();
  const match = text.match(/(\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{4}-\d{1,2}-\d{1,2})\s*[-–—]\s*(\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{4}-\d{1,2}-\d{1,2})/);
  if (!match) {
    const one = parseDate(text);
    return one ? { start: one, end: one } : null;
  }
  const start = parseDate(match[1]);
  const end = parseDate(match[2]);
  if (!start || !end || end < start) return null;
  return { start, end };
}

export function sameCalendarMonth(start: string, end: string): boolean {
  return start.slice(0, 7) === end.slice(0, 7);
}

export function inclusiveDays(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

export function monthEnd(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function wibToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts.slice(0, 10);
}

export function wibMonth(now = new Date()): string {
  return wibToday(now).slice(0, 7);
}

export function monthLabel(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return `${FULL[(mon || 1) - 1] ?? month} ${year || ""}`.trim();
}

export function monthName(iso: string): string {
  const month = Number(iso.slice(5, 7));
  return FULL[(month || 1) - 1] ?? iso;
}

function shortParts(iso: string): { day: number; month: string; year: string } {
  const [year, month, day] = iso.split("-").map(Number);
  return { day, month: SHORT[(month || 1) - 1] ?? "", year: String(year).slice(2) };
}

export function formatDay(iso: string): string {
  const part = shortParts(iso);
  return `${part.day} ${part.month} ${part.year}`;
}

export function formatDayLong(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${SHORT[(month || 1) - 1]} ${year}`;
}

export function formatPeriod(start: string, end: string): string {
  if (!start) return "—";
  if (!end || start === end) return formatDay(start);
  const a = shortParts(start);
  const b = shortParts(end);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${a.day}–${b.day} ${b.month} ${b.year}`;
  return `${formatDay(start)}–${formatDay(end)}`;
}

export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const month = SHORT[Number(pick("month")) - 1] ?? pick("month");
  return `${Number(pick("day"))} ${month} ${pick("year")} ${pick("hour")}.${pick("minute")}`;
}

export function monthBoundaryMessage(file: string, platform: string, store: string | null, start: string, end: string): string {
  const who = [platform, store].filter(Boolean).join(" · ");
  const span = `${monthName(start)}–${monthName(end)}`;
  return `File ${file}${who ? ` (${who})` : ""} mencakup ${formatDayLong(start)} s/d ${formatDayLong(end)} (${span}). Upload laporan agregat (Shopee Ads, Meta Ads, CPAS) tidak boleh melewati pergantian bulan. Silakan unduh ulang report terpisah per bulan, atau unggah hanya sisa hari di akhir bulan. Untuk TikTok (baris harian), sistem akan memecahnya otomatis. Tombol simpan dinonaktifkan.`;
}
