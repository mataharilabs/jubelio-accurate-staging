import type { CleanLine } from "@/lib/cleanup/rapikan";
import type { FieldChange, OrderVersion, ReviewItem } from "@/lib/db/types";
import { carryOrderMeta } from "@/lib/domain/phase3";
import { diffVersions, groupCleanLines, reviewsFromLines, versionFromCleanLines } from "@/lib/domain/orders";

export type ImportPlan = {
  versions: OrderVersion[];
  changes: FieldChange[];
  retireIds: string[];
  reviews: Omit<ReviewItem, "id" | "status">[];
  unchanged: number;
};

function sameSnapshot(previous: OrderVersion, next: OrderVersion): boolean {
  return diffVersions(previous, next).length === 0;
}

export function planImport(
  current: Map<string, OrderVersion>,
  lines: CleanLine[],
  meta: { importId: string | null; source: OrderVersion["source"]; createdAt: string; createdBy: string | null; duplicate?: "overwrite" | "skip"; protectManual?: boolean },
): ImportPlan {
  const versions: OrderVersion[] = [];
  const changes: FieldChange[] = [];
  const retireIds: string[] = [];
  let unchanged = 0;
  for (const group of groupCleanLines(lines)) {
    const no = group[0]?.noPesanan ?? "";
    if (!no) continue;
    const previous = current.get(no) ?? null;
    if (previous?.source === "manual" && meta.protectManual) {
      unchanged += 1;
      continue;
    }
    const next = versionFromCleanLines(group, {
      id: crypto.randomUUID(),
      versionNo: (previous?.versionNo ?? 0) + 1,
      importId: meta.importId,
      source: meta.source,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
    });
    if (previous && (meta.duplicate === "skip" || sameSnapshot(previous, next))) {
      unchanged += 1;
      continue;
    }
    const diff = diffVersions(previous, next);
    carryOrderMeta(previous, next, diff);
    if (previous) retireIds.push(previous.id);
    versions.push(next);
    changes.push(...diff);
    current.set(no, next);
  }
  return { versions, changes, retireIds, reviews: reviewsFromLines(lines), unchanged };
}

export function planCancels(
  current: Map<string, OrderVersion>,
  cancels: { noPesanan: string; status: string; day: string | null; tanggal: string | null }[],
  meta: { importId: string | null; createdAt: string; createdBy: string | null },
): ImportPlan {
  const versions: OrderVersion[] = [];
  const changes: FieldChange[] = [];
  const retireIds: string[] = [];
  for (const cancel of cancels) {
    const previous = current.get(cancel.noPesanan);
    if (!previous || previous.source === "cancel" || /^(CANCELED|CANCELLED|CANCEL)$/i.test(previous.status)) continue;
    const next: OrderVersion = {
      ...previous,
      id: crypto.randomUUID(),
      versionNo: previous.versionNo + 1,
      importId: meta.importId,
      source: "manual_edit",
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      isCurrent: true,
      status: cancel.status || "CANCELED",
      lines: previous.lines.map((line) => ({ ...line, id: crypto.randomUUID() })),
    };
    const diff = diffVersions(previous, next);
    carryOrderMeta(previous, next, diff);
    retireIds.push(previous.id);
    versions.push(next);
    changes.push(...diff);
    current.set(cancel.noPesanan, next);
  }
  return { versions, changes, retireIds, reviews: [], unchanged: 0 };
}
