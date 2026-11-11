import type { CityMapRow, ProvinceMapRow, ReviewItem } from "@/lib/db/types";
import { isMappingPending } from "@/lib/domain/phase3";
import { foldRegion, sameRegion, suggestCity, suggestProvince } from "@/lib/region/names";

export type GeoPair = {
  key: string;
  provinceRaw: string;
  cityRaw: string;
  provinceOfficial: string;
  cityOfficial: string;
  mappedAt: string | null;
  pending: boolean;
  provinceSuggestion: string;
  citySuggestion: string;
};

function pairKey(province: string, city: string): string {
  return `${foldRegion(province)}\u0000${foldRegion(city)}`;
}

function later(left?: string | null, right?: string | null): string | null {
  const a = left || "";
  const b = right || "";
  if (!a && !b) return null;
  return a > b ? a : b;
}

/**
 * One row per Jubelio province + city. A row is mapped only when both standard
 * names are filled and neither side is still waiting for a decision.
 */
export function buildGeoPairs(input: {
  provinces: ProvinceMapRow[];
  cities: CityMapRow[];
  reviews: ReviewItem[];
}): GeoPair[] {
  const pairs = new Map<string, GeoPair>();
  const provinceFor = (raw: string) => input.provinces.find((row) => sameRegion(row.raw, raw));
  const cityFor = (provinceRaw: string, cityRaw: string) => input.cities.find((row) => sameRegion(row.provinceRaw, provinceRaw) && sameRegion(row.cityRaw, cityRaw));

  const add = (provinceRaw: string, cityRaw: string) => {
    const provinceName = provinceRaw.trim();
    const cityName = cityRaw.trim();
    if (!provinceName && !cityName) return;
    const key = pairKey(provinceName, cityName);
    if (pairs.has(key)) return;
    const province = provinceName ? provinceFor(provinceName) : undefined;
    const city = cityName ? cityFor(provinceName, cityName) : undefined;
    const provinceOfficial = province?.official.trim() ?? "";
    const cityOfficial = city?.official.trim() ?? "";
    const openProvince = input.reviews.some((review) => review.status === "open" && review.kind === "province" && sameRegion(review.detail.province || review.rawKey, provinceName));
    const openCity = cityName
      ? input.reviews.some((review) => review.status === "open" && review.kind === "city" && sameRegion(review.detail.province || "", provinceName) && sameRegion(review.detail.city || review.rawKey, cityName))
      : false;
    const provincePending = provinceName ? (province ? isMappingPending(province) || !provinceOfficial : true) || openProvince : false;
    const cityPending = cityName ? (city ? isMappingPending(city) || !cityOfficial : true) || openCity : false;
    const pending = provincePending || cityPending;
    const mappedAt = pending
      ? null
      : cityName
        ? later(province?.mappedAt, city?.mappedAt)
        : (province?.mappedAt ?? null);
    pairs.set(key, {
      key,
      provinceRaw: provinceName,
      cityRaw: cityName,
      provinceOfficial,
      cityOfficial,
      mappedAt,
      pending,
      provinceSuggestion: provinceName ? (suggestProvince(provinceName, input.provinces).official ?? "") : "",
      citySuggestion: cityName ? (suggestCity(provinceName, cityName, input.provinces, input.cities).official ?? "") : "",
    });
  };

  for (const city of input.cities) add(city.provinceRaw, city.cityRaw);
  for (const review of input.reviews) {
    if (review.status !== "open") continue;
    if (review.kind === "city") add(review.detail.province || "", review.detail.city || review.rawKey);
    if (review.kind === "province") {
      const raw = review.detail.province || review.rawKey;
      const covered = [...pairs.values()].some((row) => sameRegion(row.provinceRaw, raw) && row.cityRaw);
      if (!covered) add(raw, "");
    }
  }
  for (const province of input.provinces) {
    const covered = [...pairs.values()].some((row) => sameRegion(row.provinceRaw, province.raw));
    if (!covered) add(province.raw, "");
  }

  return [...pairs.values()].sort((a, b) => a.provinceRaw.localeCompare(b.provinceRaw, "id") || a.cityRaw.localeCompare(b.cityRaw, "id"));
}

export function countPendingGeo(pairs: GeoPair[]): number {
  return pairs.filter((row) => row.pending).length;
}
