import { describe, expect, it } from "vitest";
import type { CityMapRow, ProvinceMapRow, ReviewItem } from "@/lib/db/types";
import { buildGeoPairs, countPendingGeo } from "@/lib/region/pairs";

function province(patch: Partial<ProvinceMapRow>): ProvinceMapRow {
  return { id: "p", raw: "JAWA TIMUR", official: "Jawa Timur", needsReview: false, mappedAt: "2026-10-01T00:00:00.000Z", ...patch };
}

function city(patch: Partial<CityMapRow>): CityMapRow {
  return { id: "c", provinceRaw: "JAWA TIMUR", cityRaw: "SBY", official: "Kota Surabaya", needsReview: false, mappedAt: "2026-10-02T00:00:00.000Z", ...patch };
}

describe("combined province and city rows", () => {
  it("keeps one row per Jubelio pair and a single mapping date when both sides are done", () => {
    const rows = buildGeoPairs({
      provinces: [province({})],
      cities: [city({})],
      reviews: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provinceRaw: "JAWA TIMUR",
      cityRaw: "SBY",
      provinceOfficial: "Jawa Timur",
      cityOfficial: "Kota Surabaya",
      pending: false,
      mappedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(countPendingGeo(rows)).toBe(0);
  });

  it("stays pending until both the province and the city have a standard name", () => {
    const rows = buildGeoPairs({
      provinces: [province({ official: "", mappedAt: null, needsReview: true })],
      cities: [city({ official: "Kota Surabaya", mappedAt: "2026-10-02T00:00:00.000Z", needsReview: false })],
      reviews: [],
    });
    expect(rows[0].pending).toBe(true);
    expect(rows[0].mappedAt).toBeNull();
    expect(countPendingGeo(rows)).toBe(1);
  });

  it("shows an unmapped Jubelio city from review, and a province that has no city yet", () => {
    const reviews: ReviewItem[] = [
      { id: "1", kind: "city", rawKey: "JABAR | KAB BEKASI", detail: { province: "JABAR", city: "KAB BEKASI" }, status: "open" },
      { id: "2", kind: "province", rawKey: "BALI", detail: { province: "BALI" }, status: "open" },
    ];
    const rows = buildGeoPairs({ provinces: [], cities: [], reviews });
    expect(rows.map((row) => `${row.provinceRaw}|${row.cityRaw}`)).toEqual(["BALI|", "JABAR|KAB BEKASI"]);
    expect(rows.every((row) => row.pending)).toBe(true);
    expect(countPendingGeo(rows)).toBe(2);
  });

  it("keeps a mapped pair pending while its Jubelio review is still open", () => {
    const rows = buildGeoPairs({
      provinces: [province({ raw: "JABAR", official: "Jawa Barat" })],
      cities: [city({ provinceRaw: "JABAR", cityRaw: "BEKASI", official: "Kabupaten Bekasi", mappedAt: "2026-10-02T00:00:00.000Z" })],
      reviews: [
        { id: "1", kind: "city", rawKey: "JABAR | BEKASI", detail: { province: "JABAR", city: "BEKASI" }, status: "open" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].pending).toBe(true);
    expect(rows[0].mappedAt).toBeNull();
  });

  it("does not double-count a province that already has a city row", () => {
    const rows = buildGeoPairs({
      provinces: [province({ raw: "JABAR", official: "", mappedAt: null, needsReview: true })],
      cities: [],
      reviews: [
        { id: "1", kind: "city", rawKey: "JABAR | BEKASI", detail: { province: "JABAR", city: "BEKASI" }, status: "open" },
        { id: "2", kind: "province", rawKey: "JABAR", detail: { province: "JABAR" }, status: "open" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].cityRaw).toBe("BEKASI");
    expect(countPendingGeo(rows)).toBe(1);
  });
});
