import type { InvoiceDraft } from "@/lib/accurate/invoice";
import type { SyncStatus } from "@/lib/db/types";

export type OrderPreview = InvoiceDraft & {
  lineCount: number;
  selectedLineCount: number;
  syncStatus: SyncStatus;
  accurateNumber: string | null;
  skippedReason: string | null;
};
