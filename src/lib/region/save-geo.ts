import type { GeoMapInput, GeoMapWriteResult } from "@/lib/db/geo-maps";
import type { ProvinceMapRow, ReviewItem } from "@/lib/db/types";
import { closeCityReviews, closeProvinceReviews } from "@/lib/region/apply";
import { geoPairKey } from "@/lib/region/pairs";

export type GeoSaveFailure = {
  key: string;
  provinceRaw: string;
  cityRaw: string;
  label: string;
  error: string;
};

export type GeoSaveResult = {
  saved: number;
  savedKeys: string[];
  failed: GeoSaveFailure[];
};

type GeoCommitStore = {
  saveGeoMaps(rows: GeoMapInput[]): Promise<GeoMapWriteResult>;
  listProvinceMaps(): Promise<ProvinceMapRow[]>;
  listReviews(): Promise<ReviewItem[]>;
  resolveReview(id: string): Promise<void>;
};

export function isGeoBulkBody(body: unknown): body is { items: unknown[] } {
  return Boolean(body) && typeof body === "object" && Array.isArray((body as { items?: unknown }).items);
}

export function normalizeGeoInput(input: unknown): GeoMapInput {
  const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    provinceRaw: String(row.provinceRaw ?? "").trim(),
    cityRaw: String(row.cityRaw ?? "").trim(),
    provinceOfficial: String(row.provinceOfficial ?? "").trim(),
    cityOfficial: String(row.cityOfficial ?? "").trim(),
  };
}

export function geoInputError(row: GeoMapInput): string | null {
  if (!row.provinceRaw) return "Isi provinsi dari Jubelio.";
  if (!row.provinceOfficial) return "Isi provinsi standar.";
  if (row.cityRaw && !row.cityOfficial) return "Isi kota standar.";
  if (!row.cityRaw && row.cityOfficial) return "Isi kota dari Jubelio.";
  return null;
}

export function geoRowLabel(row: { provinceRaw: string; cityRaw: string }): string {
  const province = row.provinceRaw.trim() || "(provinsi kosong)";
  if (!row.cityRaw.trim()) return province;
  return `${province} / ${row.cityRaw.trim()}`;
}

export function geoAuditEntry(actorEmail: string, row: GeoMapInput) {
  return {
    actorEmail,
    action: "mapping.geo",
    entity: "geo",
    entityId: `${row.provinceRaw} | ${row.cityRaw}`,
    before: null,
    after: {
      provinceRaw: row.provinceRaw,
      cityRaw: row.cityRaw,
      provinceOfficial: row.provinceOfficial,
      cityOfficial: row.cityOfficial,
    },
  };
}

function failure(row: GeoMapInput, error: string): GeoSaveFailure {
  return {
    key: geoPairKey(row.provinceRaw, row.cityRaw),
    provinceRaw: row.provinceRaw,
    cityRaw: row.cityRaw,
    label: geoRowLabel(row),
    error,
  };
}

/**
 * Saves one or many geo rows. Invalid rows and write errors are returned; the others are stored,
 * their reviews closed, and each success is handed to `audit` so the acting user is recorded.
 */
export async function commitGeoRows(store: GeoCommitStore, items: unknown[], audit: (row: GeoMapInput) => Promise<void>): Promise<GeoSaveResult> {
  const latest = new Map<string, GeoMapInput>();
  for (const item of items) {
    const row = normalizeGeoInput(item);
    latest.set(geoPairKey(row.provinceRaw, row.cityRaw), row);
  }
  const ready: GeoMapInput[] = [];
  const failed: GeoSaveFailure[] = [];
  for (const row of latest.values()) {
    const error = geoInputError(row);
    if (error) failed.push(failure(row, error));
    else ready.push(row);
  }
  const written = ready.length ? await store.saveGeoMaps(ready) : { saved: [], failed: [] };
  const savedKeys: string[] = [];
  for (const row of written.saved) {
    try {
      await closeProvinceReviews(store, row.provinceRaw);
      if (row.cityRaw) await closeCityReviews(store, row.provinceRaw, row.cityRaw, await store.listProvinceMaps());
      await audit(row);
      savedKeys.push(geoPairKey(row.provinceRaw, row.cityRaw));
    } catch (error) {
      failed.push(failure(row, error instanceof Error && error.message ? error.message : "Gagal menyimpan."));
    }
  }
  for (const item of written.failed) failed.push(failure(item.row, item.error));
  return { saved: savedKeys.length, savedKeys, failed };
}
