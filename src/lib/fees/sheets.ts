import * as XLSX from "xlsx";

/** SheetJS trusts the stored range. TikTok's file declares A1:X19 while the sheet has thousands of rows. */
export function usedRange(sheet: XLSX.WorkSheet): string {
  let maxRow = 0;
  let maxCol = 0;
  let found = false;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const cell = XLSX.utils.decode_cell(key);
    found = true;
    if (cell.r > maxRow) maxRow = cell.r;
    if (cell.c > maxCol) maxCol = cell.c;
  }
  if (!found) return sheet["!ref"] || "A1:A1";
  return XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
}

export function sheetMatrix(book: XLSX.WorkBook, name: string): unknown[][] {
  const sheet = book.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", range: usedRange(sheet) }) as unknown[][];
}

export function normHeader(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function headerIndex(row: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  row.forEach((cell, index) => {
    const key = normHeader(cell);
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

export function findHeader(rows: unknown[][], required: string[]): { index: number; columns: Map<string, number> } | null {
  const want = required.map((item) => normHeader(item));
  for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
    const columns = headerIndex(rows[index] ?? []);
    if (want.every((item) => columns.has(item))) return { index, columns };
  }
  return null;
}

export function cell(row: unknown[], columns: Map<string, number>, name: string): unknown {
  const index = columns.get(normHeader(name));
  if (index == null) return "";
  return row[index] ?? "";
}

export function textCell(row: unknown[], columns: Map<string, number>, name: string): string {
  return String(cell(row, columns, name) ?? "").trim();
}
