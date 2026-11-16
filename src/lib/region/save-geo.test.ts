import { describe, expect, it } from "vitest";
import { writeGeoMaps, type GeoMapInput } from "@/lib/db/geo-maps";
import type { CityMapRow, ProvinceMapRow, ReviewItem } from "@/lib/db/types";
import { geoPairKey } from "@/lib/region/pairs";
import { commitGeoRows, geoAuditEntry, geoInputError, isGeoBulkBody, normalizeGeoInput } from "@/lib/region/save-geo";

function memoryStore(seed?: { reviews?: ReviewItem[] }) {
  const provinces: ProvinceMapRow[] = [];
  const cities: CityMapRow[] = [];
  const reviews: ReviewItem[] = seed?.reviews ? seed.reviews.map((row) => ({ ...row, detail: { ...row.detail } })) : [];
  const store = {
    provinces,
    cities,
    reviews,
    async listProvinceMaps() { return provinces; },
    async listReviews() { return reviews; },
    async resolveReview(id: string) {
      const row = reviews.find((item) => item.id === id);
      if (row) row.status = "resolved" as const;
    },
    async saveProvinceMap(row: { raw: string; official: string; needsReview: boolean }) {
      const mappedAt = row.official.trim() && !row.needsReview ? "2026-11-16T00:00:00.000Z" : null;
      const next: ProvinceMapRow = { id: `p-${row.raw}`, raw: row.raw, official: row.official, needsReview: row.needsReview, mappedAt };
      const index = provinces.findIndex((item) => item.raw === row.raw);
      if (index >= 0) provinces[index] = { ...next, id: provinces[index].id };
      else provinces.push(next);
    },
    async saveCityMap(row: { provinceRaw: string; cityRaw: string; official: string; needsReview: boolean }) {
      const mappedAt = row.official.trim() && !row.needsReview ? "2026-11-16T00:00:00.000Z" : null;
      const next: CityMapRow = {
        id: `c-${row.provinceRaw}-${row.cityRaw}`,
        provinceRaw: row.provinceRaw,
        cityRaw: row.cityRaw,
        official: row.official,
        needsReview: row.needsReview,
        mappedAt,
      };
      const index = cities.findIndex((item) => item.provinceRaw === row.provinceRaw && item.cityRaw === row.cityRaw);
      if (index >= 0) cities[index] = { ...next, id: cities[index].id };
      else cities.push(next);
    },
    async saveGeoMaps(rows: GeoMapInput[]) {
      return writeGeoMaps(store, rows);
    },
  };
  return store;
}

describe("bulk geo save", () => {
  it("saves every valid row, records the user, and reports the row that failed", async () => {
    const store = memoryStore({
      reviews: [
        { id: "bali", kind: "city", rawKey: "BALI | DENPASAR", detail: { province: "BALI", city: "DENPASAR" }, status: "open" },
        { id: "sby", kind: "city", rawKey: "JATIM | SBY", detail: { province: "JATIM", city: "SBY" }, status: "open" },
      ],
    });
    const realCity = store.saveCityMap.bind(store);
    store.saveCityMap = async (row) => {
      if (row.cityRaw === "SBY") throw new Error("kota gagal");
      await realCity(row);
    };
    const audits: string[] = [];
    const result = await commitGeoRows(store, [
      { provinceRaw: "BALI", cityRaw: "DENPASAR", provinceOfficial: "Bali", cityOfficial: "Kota Denpasar" },
      { provinceRaw: "JATIM", cityRaw: "SBY", provinceOfficial: "Jawa Timur", cityOfficial: "Kota Surabaya" },
      { provinceRaw: "  ", cityRaw: "SOLO", provinceOfficial: "Jawa Tengah", cityOfficial: "Kota Surakarta" },
    ], async (row) => {
      audits.push(geoAuditEntry("admin@toko.test", row).actorEmail + ":" + row.provinceRaw);
    });

    expect(result.saved).toBe(1);
    expect(result.savedKeys).toEqual([geoPairKey("BALI", "DENPASAR")]);
    expect(result.failed.map((row) => row.cityRaw).sort()).toEqual(["SBY", "SOLO"]);
    expect(result.failed.find((row) => row.cityRaw === "SBY")).toMatchObject({
      key: geoPairKey("JATIM", "SBY"),
      label: "JATIM / SBY",
      error: "kota gagal",
    });
    expect(result.failed.find((row) => row.cityRaw === "SOLO")?.error).toBe("Isi provinsi dari Jubelio.");
    expect(store.cities.map((row) => row.cityRaw)).toEqual(["DENPASAR"]);
    expect(store.cities[0]).toMatchObject({ official: "Kota Denpasar", needsReview: false, mappedAt: "2026-11-16T00:00:00.000Z" });
    expect(store.provinces.find((row) => row.raw === "BALI")).toMatchObject({ official: "Bali", needsReview: false, mappedAt: "2026-11-16T00:00:00.000Z" });
    expect(store.reviews.find((row) => row.id === "bali")?.status).toBe("resolved");
    expect(store.reviews.find((row) => row.id === "sby")?.status).toBe("open");
    expect(audits).toEqual(["admin@toko.test:BALI"]);
  });

  it("does not call the store when every row is invalid", async () => {
    const store = memoryStore();
    let calls = 0;
    store.saveGeoMaps = async (rows) => {
      calls += 1;
      return writeGeoMaps(store, rows);
    };
    const result = await commitGeoRows(store, [{ provinceRaw: "BALI", cityRaw: "DENPASAR", provinceOfficial: "", cityOfficial: "" }], async () => {});
    expect(calls).toBe(0);
    expect(result.saved).toBe(0);
    expect(result.failed[0].error).toBe("Isi provinsi standar.");
  });
});

describe("single geo approve", () => {
  it("saves only the approved row and leaves the other review open", async () => {
    const store = memoryStore({
      reviews: [
        { id: "bali", kind: "province", rawKey: "BALI", detail: { province: "BALI" }, status: "open" },
        { id: "sby", kind: "city", rawKey: "JATIM | SBY", detail: { province: "JATIM", city: "SBY" }, status: "open" },
      ],
    });
    const approved = { provinceRaw: "BALI", cityRaw: "", provinceOfficial: "Bali", cityOfficial: "" };
    expect(isGeoBulkBody(approved)).toBe(false);
    expect(isGeoBulkBody({ items: [approved] })).toBe(true);
    const audits: unknown[] = [];
    const result = await commitGeoRows(store, [approved], async (row) => {
      audits.push(geoAuditEntry("sari@toko.test", row));
    });

    expect(result.saved).toBe(1);
    expect(result.failed).toEqual([]);
    expect(store.provinces).toEqual([
      expect.objectContaining({ raw: "BALI", official: "Bali", needsReview: false, mappedAt: "2026-11-16T00:00:00.000Z" }),
    ]);
    expect(store.cities).toEqual([]);
    expect(store.reviews.find((row) => row.id === "bali")?.status).toBe("resolved");
    expect(store.reviews.find((row) => row.id === "sby")?.status).toBe("open");
    expect(audits).toEqual([
      {
        actorEmail: "sari@toko.test",
        action: "mapping.geo",
        entity: "geo",
        entityId: "BALI | ",
        before: null,
        after: approved,
      },
    ]);
  });

  it("keeps a province-only approve from writing a city", async () => {
    const calls: string[] = [];
    const result = await writeGeoMaps({
      async saveProvinceMap(row) { calls.push(`province:${row.raw}:${row.official}:${row.needsReview}`); },
      async saveCityMap(row) { calls.push(`city:${row.cityRaw}`); },
    }, [{ provinceRaw: "BALI", cityRaw: "", provinceOfficial: "Bali", cityOfficial: "" }]);
    expect(result.saved).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(calls).toEqual(["province:BALI:Bali:false"]);
  });
});

describe("geo save validation", () => {
  it("rejects a city standard name when the Jubelio city is empty", () => {
    expect(geoInputError(normalizeGeoInput({ provinceRaw: "BALI", cityRaw: "", provinceOfficial: "Bali", cityOfficial: "Denpasar" }))).toBe("Isi kota dari Jubelio.");
  });
});
