import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitizeSettings } from "@/lib/db/defaults";
import { aggregateBatch, applyLinePatch, withWeights } from "@/lib/db/rules";
import type { DataStore, OrderSyncInput } from "@/lib/db/store";
import type {
  AccurateTokens,
  AppSettings,
  Batch,
  BundleWeight,
  CreateBatchInput,
  DashboardStats,
  LinePatch,
  OrderSync,
  SalesLine,
} from "@/lib/db/types";
import { AppError } from "@/lib/errors";

type LocalDB = {
  version: 1;
  weights: BundleWeight[];
  batches: Batch[];
  lines: SalesLine[];
  syncs: OrderSync[];
  settings: AppSettings;
  tokens: AccurateTokens | null;
};

function emptyDb(): LocalDB {
  return {
    version: 1,
    weights: [],
    batches: [],
    lines: [],
    syncs: [],
    settings: sanitizeSettings(null),
    tokens: null,
  };
}

export function localDbPath(): string {
  if (process.env.VERCEL) return "/tmp/jubelio-local-db.json";
  return path.join(process.cwd(), "data", "local-db.json");
}

export class LocalStore implements DataStore {
  mode = "local" as const;
  ephemeral = Boolean(process.env.VERCEL);
  private chain: Promise<unknown> = Promise.resolve();

  private async withDb<T>(fn: (db: LocalDB) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const db = this.read();
      const result = await fn(db);
      this.write(db);
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private read(): LocalDB {
    const file = localDbPath();
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as LocalDB;
      parsed.settings = sanitizeSettings(parsed.settings);
      parsed.weights ??= [];
      parsed.batches ??= [];
      parsed.lines ??= [];
      parsed.syncs ??= [];
      parsed.tokens ??= null;
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyDb();
      throw new AppError("Berkas data lokal rusak. Hapus data/local-db.json lalu muat ulang.");
    }
  }

  private write(db: LocalDB) {
    const file = localDbPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(db));
  }

  private touch(db: LocalDB, batchId: string) {
    const batch = db.batches.find((row) => row.id === batchId);
    if (!batch) return;
    const lines = db.lines.filter((row) => row.batchId === batchId);
    const next = aggregateBatch(batch, lines);
    Object.assign(batch, next);
  }

  dashboard(): Promise<{ batches: Batch[]; stats: DashboardStats }> {
    return this.withDb((db) => {
      const batches = [...db.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const stats: DashboardStats = {
        batchCount: batches.length,
        lineCount: batches.reduce((sum, batch) => sum + batch.rowCount, 0),
        grossTotal: batches.reduce((sum, batch) => sum + batch.grossTotal, 0),
        discountTotal: batches.reduce((sum, batch) => sum + batch.discountTotal, 0),
        unsyncedOrders: batches.reduce((sum, batch) => sum + batch.unsyncedCount, 0),
        missingWeights: batches.reduce((sum, batch) => sum + batch.missingWeightCount, 0),
        weightCount: db.weights.length,
      };
      return { batches, stats };
    });
  }

  getBatchBundle(id: string) {
    return this.withDb((db) => {
      const batch = db.batches.find((row) => row.id === id);
      if (!batch) return null;
      const lines = db.lines
        .filter((row) => row.batchId === id)
        .sort((a, b) => a.rowIndex - b.rowIndex);
      const syncs = db.syncs.filter((row) => row.batchId === id);
      return { batch, lines, syncs };
    });
  }

  createBatch(input: CreateBatchInput) {
    return this.withDb((db) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const lines: SalesLine[] = input.lines.map((line) => ({
        ...line,
        id: crypto.randomUUID(),
        batchId: id,
        syncStatus: "belum",
      }));
      const batch = aggregateBatch(
        {
          id,
          reportDate: input.reportDate,
          filename: input.filename,
          rowCount: 0,
          droppedCount: input.droppedCount,
          missingWeightCount: 0,
          grossTotal: 0,
          discountTotal: 0,
          orderCount: 0,
          unsyncedCount: 0,
          createdAt: now,
          createdBy: input.createdBy,
        },
        lines,
      );
      db.batches.push(batch);
      db.lines.push(...lines);
      return batch;
    });
  }

  deleteBatch(id: string) {
    return this.withDb((db) => {
      db.batches = db.batches.filter((row) => row.id !== id);
      db.lines = db.lines.filter((row) => row.batchId !== id);
      db.syncs = db.syncs.filter((row) => row.batchId !== id);
    });
  }

  updateLine(id: string, patch: LinePatch) {
    return this.withDb((db) => {
      const line = db.lines.find((row) => row.id === id);
      if (!line) throw new AppError("Baris tidak ditemukan.", 404);
      const previous = line.noPesanan;
      const siblings = db.lines.filter((row) => row.batchId === line.batchId);
      const next = applyLinePatch(line, patch, siblings);
      Object.assign(line, next);
      if (previous !== line.noPesanan) {
        const stillThere = db.lines.some((row) => row.batchId === line.batchId && row.noPesanan === previous);
        if (!stillThere) {
          db.syncs = db.syncs.filter(
            (row) => !(row.batchId === line.batchId && row.noPesanan === previous && row.status !== "tersinkron"),
          );
        }
      }
      this.touch(db, line.batchId);
      return { ...line };
    });
  }

  deleteLines(ids: string[]) {
    return this.withDb((db) => {
      const idset = new Set(ids);
      const chosen = db.lines.filter((row) => idset.has(row.id));
      const blocked = chosen.filter((row) => row.syncStatus === "tersinkron");
      const blockedIds = new Set(blocked.map((row) => row.id));
      const removed = chosen.filter((row) => !blockedIds.has(row.id));
      const batchIds = new Set(removed.map((row) => row.batchId));
      const orders = removed.map((row) => ({ batchId: row.batchId, noPesanan: row.noPesanan }));
      db.lines = db.lines.filter((row) => !removed.some((item) => item.id === row.id));
      const seen = new Set<string>();
      for (const item of orders) {
        const key = `${item.batchId}\0${item.noPesanan}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { batchId, noPesanan } = item;
        const remains = db.lines.some((row) => row.batchId === batchId && row.noPesanan === noPesanan);
        if (!remains) {
          db.syncs = db.syncs.filter(
            (row) => !(row.batchId === batchId && row.noPesanan === noPesanan && row.status !== "tersinkron"),
          );
        }
      }
      for (const batchId of batchIds) this.touch(db, batchId);
      return { deleted: removed.length, blocked: blocked.length };
    });
  }

  listWeights() {
    return this.withDb((db) => [...db.weights].sort((a, b) => a.bundleKey.localeCompare(b.bundleKey)));
  }

  upsertWeights(rows: { bundleKey: string; bobot: number }[], replace: boolean) {
    return this.withDb((db) => {
      if (replace) db.weights = [];
      const now = new Date().toISOString();
      for (const row of rows) {
        const bundleKey = row.bundleKey.trim();
        if (!bundleKey) continue;
        if (!Number.isFinite(row.bobot) || row.bobot < 0) {
          throw new AppError(`Bobot tidak valid untuk ${bundleKey}.`);
        }
        const existing = db.weights.find((item) => item.bundleKey === bundleKey);
        if (existing) {
          existing.bobot = row.bobot;
          existing.updatedAt = now;
        } else {
          db.weights.push({ id: crypto.randomUUID(), bundleKey, bobot: row.bobot, updatedAt: now });
        }
      }
      return db.weights.length;
    });
  }

  updateWeight(id: string, patch: { bundleKey?: string; bobot?: number }) {
    return this.withDb((db) => {
      const weight = db.weights.find((row) => row.id === id);
      if (!weight) throw new AppError("Bobot tidak ditemukan.", 404);
      if (patch.bundleKey != null) {
        const bundleKey = patch.bundleKey.trim();
        if (!bundleKey) throw new AppError("Kunci bundle tidak boleh kosong.");
        if (db.weights.some((row) => row.id !== id && row.bundleKey === bundleKey)) {
          throw new AppError("Kunci bundle sudah ada.");
        }
        weight.bundleKey = bundleKey;
      }
      if (patch.bobot != null) {
        if (!Number.isFinite(patch.bobot) || patch.bobot < 0) throw new AppError("Bobot tidak valid.");
        weight.bobot = patch.bobot;
      }
      weight.updatedAt = new Date().toISOString();
      return { ...weight };
    });
  }

  deleteWeight(id: string) {
    return this.withDb((db) => {
      db.weights = db.weights.filter((row) => row.id !== id);
    });
  }

  weightMap() {
    return this.withDb((db) => new Map(db.weights.map((row) => [row.bundleKey, row.bobot])));
  }

  getSettings() {
    return this.withDb((db) => db.settings);
  }

  saveSettings(settings: AppSettings) {
    return this.withDb((db) => {
      db.settings = sanitizeSettings(settings);
      return db.settings;
    });
  }

  getTokens() {
    return this.withDb((db) => db.tokens);
  }

  saveTokens(tokens: AccurateTokens | null) {
    return this.withDb((db) => {
      db.tokens = tokens;
    });
  }

  linesForOrders(batchId: string, orderNos: string[]) {
    return this.withDb((db) => {
      const wanted = new Set(orderNos);
      return db.lines
        .filter((row) => row.batchId === batchId && wanted.has(row.noPesanan))
        .sort((a, b) => a.rowIndex - b.rowIndex);
    });
  }

  saveOrderSync(input: OrderSyncInput) {
    return this.withDb((db) => {
      const now = new Date().toISOString();
      let sync = db.syncs.find((row) => row.batchId === input.batchId && row.noPesanan === input.noPesanan);
      if (!sync) {
        sync = {
          id: crypto.randomUUID(),
          batchId: input.batchId,
          noPesanan: input.noPesanan,
          status: input.status,
          accurateId: null,
          accurateNumber: null,
          payload: null,
          response: null,
          error: null,
          syncedAt: null,
          syncedBy: null,
        };
        db.syncs.push(sync);
      }
      if (sync.status === "tersinkron" && input.status === "tersinkron") {
        throw new AppError(`Pesanan ${input.noPesanan} sudah tersinkron.`);
      }
      const elsewhere = db.syncs.find(
        (row) => row.noPesanan === input.noPesanan && row.batchId !== input.batchId && row.status === "tersinkron",
      );
      if (input.status === "tersinkron" && elsewhere) {
        throw new AppError(`Pesanan ${input.noPesanan} sudah tersinkron di batch lain.`);
      }
      sync.status = input.status;
      if (input.accurateId !== undefined) sync.accurateId = input.accurateId;
      if (input.accurateNumber !== undefined) sync.accurateNumber = input.accurateNumber;
      if (input.payload !== undefined) sync.payload = input.payload;
      if (input.response !== undefined) sync.response = input.response;
      if (input.error !== undefined) sync.error = input.error;
      if (input.syncedAt !== undefined) sync.syncedAt = input.syncedAt;
      if (input.syncedBy !== undefined) sync.syncedBy = input.syncedBy;
      if (input.status === "tersinkron" && !sync.syncedAt) sync.syncedAt = now;
      for (const line of db.lines) {
        if (line.batchId === input.batchId && line.noPesanan === input.noPesanan) line.syncStatus = input.status;
      }
      this.touch(db, input.batchId);
      return { ...sync };
    });
  }

  findSyncedElsewhere(noPesanan: string, batchId: string) {
    return this.withDb(
      (db) =>
        db.syncs.find(
          (row) => row.noPesanan === noPesanan && row.batchId !== batchId && row.status === "tersinkron",
        ) ?? null,
    );
  }

  resetOrder(batchId: string, noPesanan: string) {
    return this.withDb((db) => {
      const sync = db.syncs.find((row) => row.batchId === batchId && row.noPesanan === noPesanan);
      if (sync) {
        sync.status = "belum";
        sync.error = null;
      }
      for (const line of db.lines) {
        if (line.batchId === batchId && line.noPesanan === noPesanan) line.syncStatus = "belum";
      }
      this.touch(db, batchId);
    });
  }

  recalcBatch(batchId: string) {
    return this.withDb((db) => {
      const weights = new Map(db.weights.map((row) => [row.bundleKey, row.bobot]));
      let updated = 0;
      let skipped = 0;
      for (const line of db.lines) {
        if (line.batchId !== batchId) continue;
        if (line.syncStatus === "tersinkron") {
          skipped += 1;
          continue;
        }
        Object.assign(line, withWeights(line, weights));
        updated += 1;
      }
      this.touch(db, batchId);
      return { updated, skipped };
    });
  }
}
