import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCityWorkbook, readProvinceWorkbook } from "@/lib/cleanup/read-xlsx";
import { closeCityReviews, closeProvinceReviews } from "@/lib/region/apply";
import { findCity, findProvince, OFFICIAL_PROVINCES, suggestCity, suggestProvince } from "@/lib/region/names";
import type { ReviewItem } from "@/lib/db/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const provinces = readProvinceWorkbook(readFileSync(path.join(root, "samples/mapping-provinsi.xlsx")));
const cities = readCityWorkbook(readFileSync(path.join(root, "samples/mapping-kota.xlsx")));

describe("region name matching", () => {
  it("bundles the 38 Kemendagri provinces and the example regencies", () => {
    expect(OFFICIAL_PROVINCES).toHaveLength(38);
    expect(OFFICIAL_PROVINCES).toContain("DKI Jakarta");
    expect(suggestCity("Jawa Barat", "CIAMIS", [], []).official).toBe("Kabupaten Ciamis");
    expect(suggestCity("Sulawesi Selatan", "KAB. TAKALAR", [], []).official).toBe("Kabupaten Takalar");
    expect(suggestCity("Jawa Tengah", "KOTA SALATIGA", [], []).official).toBe("Kota Salatiga");
    expect(suggestProvince("GORONTALO", []).official).toBe("Gorontalo");
  });

  it("matches existing province rows when only case or a space inside a word differs", () => {
    expect(findProvince(provinces, "Bali")?.official).toBe("Bali");
    expect(findProvince(provinces, "Sumatera Utara")?.official).toBe("Sumatera Utara");
    expect(findProvince(provinces, "Sulawesi Selatan")?.official).toBe("Sulawesi Selatan");
    expect(findProvince(provinces, "DKI Jak arta")?.official).toBe("DKI Jakarta");
    expect(findProvince(provinces, "DKI  Jakarta")?.official).toBe("DKI Jakarta");
    expect(findProvince(provinces, "GORONTALO")).toBeUndefined();
  });

  it("matches a city through case, a dropped prefix, or a space inside a word when the official name is unique", () => {
    expect(findCity(cities, "Bali", "Denpasar")?.official).toBe("Kota Denpasar");
    expect(findCity(cities, "Jawa Tengah", "KOTA SALATIGA")?.official).toBe("Kota Salatiga");
    expect(findCity(cities, "Jawa Timur", "Kota Su rabaya")?.official).toBe("Kota Surabaya");
    expect(findCity([{ provinceRaw: "SULAWESI SELATAN", cityRaw: "KOTA PAREPARE", official: "Kota Parepare", needsReview: false }], "Sulawesi Selatan", "PARE PARE")?.official).toBe("Kota Parepare");
    expect(findCity(cities, "Jawa Barat", "KAB. BOGOR")?.official).toBe("Kabupaten Bogor");
    expect(findCity(cities, "Jawa Barat", "BOGOR")?.official).toBe("Kota Bogor");
    expect(findCity([{ provinceRaw: "SUMATERA BARAT", cityRaw: "SOLOK", official: "Kota Solok", needsReview: false }], "Sumatera Barat", "KAB. SOLOK")).toBeUndefined();
    expect(findCity([
      { provinceRaw: "JAWA TIMUR", cityRaw: "PASURUAN", official: "Kota Pasuruan", needsReview: false },
      { provinceRaw: "JAWA TIMUR", cityRaw: "KAB. PASURUAN", official: "Kabupaten Pasuruan", needsReview: false },
    ], "Jawa Timur", "KOTA PASURUAN")?.official).toBe("Kota Pasuruan");
    expect(suggestCity("Sumatera Barat", "KAB. SOLOK", [], []).official).toBe("Kabupaten Solok");
  });

  it("keeps JAWA BARAT / CIREBON distinct from Jawa Barat / Cirebon and still matches a city saved under the official province", () => {
    const provinces = [{ raw: "NANGGROE ACEH DARUSSALAM", official: "Aceh", needsReview: false }];
    const cities = [
      { provinceRaw: "JAWA BARAT", cityRaw: "CIREBON", official: "Kota Cirebon", needsReview: false },
      { provinceRaw: "Jawa Barat", cityRaw: "Cirebon", official: "Kabupaten Cirebon", needsReview: false },
      { provinceRaw: "Aceh", cityRaw: "JANTHO", official: "Kota Jantho", needsReview: false },
    ];
    expect(findCity(cities, "JAWA BARAT", "CIREBON", provinces)?.official).toBe("Kota Cirebon");
    expect(findCity(cities, "Jawa Barat", "Cirebon", provinces)?.official).toBe("Kabupaten Cirebon");
    expect(findCity(cities, "jawa barat", "cirebon", provinces)).toBeUndefined();
    expect(findCity(cities, "NANGGROE ACEH DARUSSALAM", "JANTHO", provinces)?.official).toBe("Kota Jantho");
  });

  it("does not invent a regency for a district capital or an ambiguous bare name", () => {
    expect(suggestCity("Aceh", "JANTHO", provinces, cities).official).toBeNull();
    expect(suggestCity("Jawa Tengah", "UNGARAN", provinces, cities).official).toBeNull();
    expect(suggestCity("Kalimantan Timur", "TENGGARONG", provinces, cities).official).toBeNull();
    const bare = suggestCity("Jawa Barat", "NAMA YANG TIDAK ADA", [], []);
    expect(bare.official).toBeNull();
    expect(bare.ambiguous).toBe(false);
  });

  it("closes only the province and city reviews with the same normalized text", async () => {
    const reviews: ReviewItem[] = [
      { id: "bali", kind: "province", rawKey: "Bali", detail: { province: "Bali" }, status: "open" },
      { id: "BALI", kind: "province", rawKey: "BALI", detail: { province: "BALI" }, status: "open" },
      { id: "jatim", kind: "province", rawKey: "Jawa Timur", detail: { province: "Jawa Timur" }, status: "open" },
      { id: "bogor", kind: "city", rawKey: "Jawa Barat | BOGOR", detail: { province: "Jawa Barat", city: "BOGOR" }, status: "open" },
      { id: "kab", kind: "city", rawKey: "Jawa Barat | KAB. BOGOR", detail: { province: "Jawa Barat", city: "KAB. BOGOR" }, status: "open" },
      { id: "cirebon", kind: "city", rawKey: "Jawa Barat | Cirebon", detail: { province: "Jawa Barat", city: "Cirebon" }, status: "open" },
      { id: "CIREBON", kind: "city", rawKey: "Jawa Barat | CIREBON", detail: { province: "Jawa Barat", city: "CIREBON" }, status: "open" },
    ];
    const closed: string[] = [];
    const store = {
      listReviews: async () => reviews,
      resolveReview: async (id: string) => { closed.push(id); },
    };
    await closeProvinceReviews(store, "bali");
    await closeCityReviews(store, "Jawa Barat", "Cirebon");
    await closeCityReviews(store, "Jawa Barat", "KAB. BOGOR");
    expect(closed.sort()).toEqual(["BALI", "CIREBON", "bali", "cirebon", "kab"]);
  });
});
