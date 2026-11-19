import { duplicateGroups } from "@/lib/marketing/overlap";
import type { DuplicateGroup, MarketingRecord } from "@/lib/marketing/types";

export type SpendAudit = {
  id: string;
  at: string;
  spendId: string | null;
  uploadId: string | null;
  action: "create" | "overwrite" | "delete";
  actor: string;
  platform: string;
  storeName: string;
  periodStart: string;
  periodEnd: string;
  snapshot: unknown;
};

export type SpendFile = {
  rows: MarketingRecord[];
  audit: SpendAudit[];
};

export type SavePlan =
  | { ok: true; db: SpendFile; inserted: number; replaced: number }
  | { ok: false; duplicates: DuplicateGroup[] };

function spans(rows: MarketingRecord[]) {
  return rows.filter((row) => !row.deletedAt).map((row) => ({
    id: row.id,
    platform: row.platform,
    storeName: row.storeName,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  }));
}

/** Next file contents for one Timpa or insert. Does not mutate the input. */
export function planSave(db: SpendFile, created: MarketingRecord[], overwrite: boolean, now: string): SavePlan {
  const duplicates = duplicateGroups(spans(db.rows), created);
  if (duplicates.length && !overwrite) return { ok: false, duplicates };
  const oldIds = new Set(duplicates.flatMap((group) => group.ids));
  const actor = created[0]?.createdBy ?? "";
  const rows = db.rows.map((row) => oldIds.has(row.id) && !row.deletedAt
    ? { ...row, deletedAt: now, deletedBy: actor }
    : row);
  rows.push(...created.map((row) => ({ ...row })));
  const replaced = db.rows.filter((row) => oldIds.has(row.id));
  const audit: SpendAudit[] = [
    ...replaced.map((row) => ({
      id: crypto.randomUUID(),
      at: now,
      spendId: row.id,
      uploadId: created[0]?.uploadId ?? null,
      action: "overwrite" as const,
      actor,
      platform: row.platform,
      storeName: row.storeName,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      snapshot: row,
    })),
    {
      id: crypto.randomUUID(),
      at: now,
      spendId: null,
      uploadId: created[0]?.uploadId ?? null,
      action: "create" as const,
      actor,
      platform: created[0]?.platform ?? "",
      storeName: created[0]?.storeName ?? "",
      periodStart: created.reduce((min, row) => row.periodStart < min ? row.periodStart : min, created[0]?.periodStart ?? ""),
      periodEnd: created.reduce((max, row) => row.periodEnd > max ? row.periodEnd : max, created[0]?.periodEnd ?? ""),
      snapshot: { count: created.length, ids: created.map((row) => row.id) },
    },
    ...db.audit,
  ].slice(0, 5000);
  return { ok: true, db: { rows, audit }, inserted: created.length, replaced: replaced.length };
}

/** Soft-delete and its audit, as one new file. Does not mutate the input. */
export function planDelete(db: SpendFile, ids: string[], actor: string, now: string): SpendFile {
  const wanted = new Set(ids);
  const doomed = db.rows.filter((row) => wanted.has(row.id) && !row.deletedAt);
  const rows = db.rows.map((row) => wanted.has(row.id) && !row.deletedAt
    ? { ...row, deletedAt: now, deletedBy: actor }
    : row);
  const audit: SpendAudit[] = [
    ...doomed.map((row) => ({
      id: crypto.randomUUID(),
      at: now,
      spendId: row.id,
      uploadId: row.uploadId || null,
      action: "delete" as const,
      actor,
      platform: row.platform,
      storeName: row.storeName,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      snapshot: row,
    })),
    ...db.audit,
  ].slice(0, 5000);
  return { rows, audit };
}
