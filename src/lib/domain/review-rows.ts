import type { FieldChange, OrderVersion, SyncReviewRow, SyncState } from "@/lib/db/types";
import { canSync, classifyOrder, diffVersions, summaryOf } from "@/lib/domain/orders";

export function reviewRow(current: OrderVersion, synced: OrderVersion | null, state: SyncState | null): SyncReviewRow | null {
  const category = classifyOrder(current, synced);
  if (!category) return null;
  const changes: FieldChange[] = synced ? diffVersions(synced, current) : [];
  const ignored = state?.decision === "ignored" && state.decisionVersionId === current.id;
  const summary = ignored ? "Dianggap tidak ada perubahan — tidak ikut sync" : summaryOf(category, changes);
  return {
    noPesanan: current.noPesanan,
    day: current.day,
    category,
    decision: state?.decisionVersionId === current.id ? state.decision : null,
    selectable: canSync(category, state?.decision ?? null, state?.decisionVersionId ?? null, current.id),
    summary,
    current,
    baseline: synced,
    changes,
    accurateNumber: state?.accurateNumber ?? null,
  };
}
