/** Marketplace files store a cost as a negative number. Rupiah stored here is positive when it costs the seller. */
export function costFromDeduction(fileAmount: number): number {
  if (!Number.isFinite(fileAmount)) return 0;
  return -fileAmount;
}

export function parseAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  let text = value.trim().replace(/\s/g, "").replace(/rp/ig, "");
  if (!text || text === "-" || text === "—") return 0;
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
  } else if (text.includes(",")) {
    const parts = text.split(",");
    text = parts.length === 2 && parts[1].length <= 2
      ? `${parts[0].replace(/\./g, "")}.${parts[1]}`
      : text.replace(/,/g, "");
  }
  const amount = Number(text);
  if (!Number.isFinite(amount)) return 0;
  return negative ? -amount : amount;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Percent of base (9.5 means 9.5%), or null when the base is zero. */
export function percentOf(cost: number, base: number): number | null {
  if (!base || !Number.isFinite(cost) || !Number.isFinite(base)) return null;
  return Math.round((cost / base) * 100 * 10000) / 10000;
}

/** HPP inkl. PPN: missing DPP counts as 0. Matches round(unit_cost * 1.11) * qty. */
export function extendedHpp(unitCost: number | null | undefined, qty: number): number {
  if (unitCost == null || !Number.isFinite(unitCost)) return 0;
  return Math.round(unitCost * 1.11) * qty;
}

export function isCancelledStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toUpperCase().startsWith("CANCEL");
}

export function normName(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
