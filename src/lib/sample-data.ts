import { readFileSync } from "node:fs";
import path from "node:path";
import { rapikan } from "@/lib/cleanup/rapikan";
import { readSalesWorkbook, readWeightWorkbook, reportDateFromFilename } from "@/lib/cleanup/read-xlsx";
import type { DataStore } from "@/lib/db/store";
import type { NewLine } from "@/lib/db/types";

const salesPath = path.join(process.cwd(), "samples/laporan-penjualan-2026-10-26-lintas-sby-jkt.xlsx");
const weightPath = path.join(process.cwd(), "samples/bobot-bundle.xlsx");

export async function importSalesBuffer(
  store: DataStore,
  buffer: Buffer,
  filename: string,
  actor: string | null,
) {
  const raw = readSalesWorkbook(buffer);
  const cleaned = rapikan(raw, await store.weightMap());
  const lines: NewLine[] = cleaned.lines.map((line, rowIndex) => ({ ...line, rowIndex }));
  return store.createBatch({
    filename,
    reportDate: reportDateFromFilename(filename, lines.map((line) => line.tanggal)),
    droppedCount: cleaned.droppedCount,
    createdBy: actor,
    lines,
  });
}

export async function loadSampleData(store: DataStore, actor: string) {
  if ((await store.listWeights()).length === 0) {
    await store.upsertWeights(readWeightWorkbook(readFileSync(weightPath)), false);
  }
  return importSalesBuffer(
    store,
    readFileSync(salesPath),
    "Laporan_Penjualan_2026-10-26_Lintas_Sby_JKT.xlsx",
    actor,
  );
}
