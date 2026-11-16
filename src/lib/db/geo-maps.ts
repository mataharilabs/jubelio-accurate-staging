export type GeoMapInput = {
  provinceRaw: string;
  cityRaw: string;
  provinceOfficial: string;
  cityOfficial: string;
};

export type GeoMapWriteResult = {
  saved: GeoMapInput[];
  failed: { row: GeoMapInput; error: string }[];
};

type GeoMapWriter = {
  saveProvinceMap(row: { raw: string; official: string; needsReview: boolean }): Promise<void>;
  saveCityMap(row: { provinceRaw: string; cityRaw: string; official: string; needsReview: boolean }): Promise<void>;
};

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Gagal menyimpan.";
}

/** Saves each province/city pair with the existing map writes. One failure does not stop the rest. */
export async function writeGeoMaps(store: GeoMapWriter, rows: GeoMapInput[]): Promise<GeoMapWriteResult> {
  const saved: GeoMapInput[] = [];
  const failed: { row: GeoMapInput; error: string }[] = [];
  for (const row of rows) {
    try {
      await store.saveProvinceMap({ raw: row.provinceRaw, official: row.provinceOfficial, needsReview: false });
      if (row.cityRaw) {
        await store.saveCityMap({
          provinceRaw: row.provinceRaw,
          cityRaw: row.cityRaw,
          official: row.cityOfficial,
          needsReview: false,
        });
      }
      saved.push(row);
    } catch (error) {
      failed.push({ row, error: errorText(error) });
    }
  }
  return { saved, failed };
}
