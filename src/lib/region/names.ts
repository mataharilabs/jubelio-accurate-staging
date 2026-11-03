import wilayah from "@/lib/region/wilayah.json";

export type RegionRow = { official: string; needsReview: boolean };
export type ProvinceSource = RegionRow & { raw: string };
export type CitySource = RegionRow & { provinceRaw: string; cityRaw: string };

export type RegionHit = RegionRow & { exact: boolean };

export type NameSuggestion = {
  official: string | null;
  ambiguous: boolean;
  fromMapping: boolean;
};

type CatalogCity = { province: string; name: string };

const PROVINCE_ALIASES: Record<string, string> = {
  dki: "DKI Jakarta",
  dkijakarta: "DKI Jakarta",
  daerahkhususibukotajakarta: "DKI Jakarta",
  diy: "Daerah Istimewa Yogyakarta",
  diyogyakarta: "Daerah Istimewa Yogyakarta",
  daerahistimewayogyakarta: "Daerah Istimewa Yogyakarta",
  nad: "Aceh",
  nanggroeacehdarussalam: "Aceh",
  ntb: "Nusa Tenggara Barat",
  ntt: "Nusa Tenggara Timur",
};

export const OFFICIAL_PROVINCES: readonly string[] = wilayah.provinces;
export const OFFICIAL_CITIES: readonly CatalogCity[] = wilayah.cities;

/** Case, extra spaces, dots, and a trailing parenthetical or slash alias. */
export function foldRegion(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/\([^)]*\)/g, " ")
    .split("/")[0]
    .replace(/[.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function compactRegion(value: string): string {
  return foldRegion(value).replace(/ /g, "");
}

function stripAdmin(folded: string): string {
  return folded.replace(/^(kota administrasi|kabupaten|kab|kota)\s+/, "").trim();
}

export function sameRegion(left: string, right: string): boolean {
  return sameText(left, right);
}

function sameText(left: string, right: string): boolean {
  if (!left.trim() || !right.trim()) return false;
  const folded = foldRegion(left);
  if (folded === foldRegion(right)) return true;
  const compact = compactRegion(left);
  return compact.length > 2 && compact === compactRegion(right);
}

function samePlace(left: string, right: string): boolean {
  if (sameText(left, right)) return true;
  const leftStem = stripAdmin(foldRegion(left));
  const rightStem = stripAdmin(foldRegion(right));
  if (!leftStem || !rightStem) return false;
  if (leftStem === rightStem) return true;
  const compact = leftStem.replace(/ /g, "");
  return compact.length > 2 && compact === rightStem.replace(/ /g, "");
}

function prefixKind(value: string): "kabupaten" | "kota" | null {
  const folded = foldRegion(value);
  if (/^(kabupaten|kab)\s+/.test(folded)) return "kabupaten";
  if (/^(kota administrasi|kota)\s+/.test(folded)) return "kota";
  return null;
}

function officialKind(value: string): "kabupaten" | "kota" | null {
  const folded = foldRegion(value);
  if (folded.startsWith("kabupaten ")) return "kabupaten";
  if (folded.startsWith("kota ")) return "kota";
  return null;
}

function kindAgrees(raw: string, row: CitySource): boolean {
  const wanted = prefixKind(raw);
  if (!wanted) return true;
  const fromRaw = prefixKind(row.cityRaw);
  const fromOfficial = officialKind(row.official);
  if (fromRaw && fromRaw !== wanted) return false;
  if (fromOfficial && fromOfficial !== wanted) return false;
  return true;
}

function consensus<T extends RegionRow>(rows: T[]): T | undefined {
  const usable = rows.filter((row) => row.official.trim());
  const officials = new Set(usable.map((row) => row.official.trim()));
  if (officials.size !== 1) return undefined;
  return usable.find((row) => !row.needsReview) ?? usable[0];
}

export function findProvince(rows: ProvinceSource[], raw: string): RegionHit | undefined {
  if (!raw.trim()) return undefined;
  const exact = rows.find((row) => row.raw === raw);
  if (exact) return { official: exact.official, needsReview: exact.needsReview, exact: true };
  const hit = consensus(rows.filter((row) => sameText(row.raw, raw)));
  return hit ? { official: hit.official, needsReview: hit.needsReview, exact: false } : undefined;
}

function provinceLabel(raw: string, provinces: ProvinceSource[]): string {
  const official = findProvince(provinces, raw)?.official.trim();
  if (official) return foldRegion(official);
  const catalog = catalogProvince(raw);
  return catalog ? foldRegion(catalog) : "";
}

/** Raw Jubelio text, or the same official province (Aceh and Nanggroe Aceh Darussalam). */
export function sameProvinceScope(rowProvince: string, incoming: string, provinces: ProvinceSource[] = []): boolean {
  if (sameText(rowProvince, incoming)) return true;
  const incomingLabel = provinceLabel(incoming, provinces);
  if (!incomingLabel) return false;
  if (sameText(rowProvince, incomingLabel)) return true;
  const rowLabel = provinceLabel(rowProvince, provinces);
  return Boolean(rowLabel) && rowLabel === incomingLabel;
}

export function findCity(rows: CitySource[], provinceRaw: string, cityRaw: string, provinces: ProvinceSource[] = []): RegionHit | undefined {
  if (!cityRaw.trim()) return undefined;
  const exact = rows.find((row) => row.provinceRaw === provinceRaw && row.cityRaw === cityRaw);
  if (exact) return { official: exact.official, needsReview: exact.needsReview, exact: true };
  const inProvince = rows.filter((row) => sameProvinceScope(row.provinceRaw, provinceRaw, provinces));
  const tight = consensus(inProvince.filter((row) => sameText(row.cityRaw, cityRaw)));
  if (tight) return { official: tight.official, needsReview: tight.needsReview, exact: false };
  const kind = prefixKind(cityRaw);
  if (kind) {
    const typed = consensus(inProvince.filter((row) => kindAgrees(cityRaw, row) && samePlace(row.cityRaw, cityRaw)));
    if (typed) return { official: typed.official, needsReview: typed.needsReview, exact: false };
  }
  const stemmed = consensus(inProvince.filter((row) => kindAgrees(cityRaw, row) && samePlace(row.cityRaw, cityRaw)));
  return stemmed ? { official: stemmed.official, needsReview: stemmed.needsReview, exact: false } : undefined;
}

function catalogProvince(raw: string): string | null {
  const compact = compactRegion(raw);
  if (PROVINCE_ALIASES[compact]) return PROVINCE_ALIASES[compact];
  const folded = foldRegion(raw);
  const hits = OFFICIAL_PROVINCES.filter((name) => foldRegion(name) === folded || compactRegion(name) === compact);
  return hits.length === 1 ? hits[0] : null;
}

export function suggestProvince(raw: string, rows: ProvinceSource[]): NameSuggestion {
  const mapped = findProvince(rows, raw);
  if (mapped?.official.trim()) return { official: mapped.official.trim(), ambiguous: false, fromMapping: true };
  const official = catalogProvince(raw);
  return { official, ambiguous: false, fromMapping: false };
}

function provinceScope(provinceRaw: string, provinceRows: ProvinceSource[]): string | null {
  const mapped = findProvince(provinceRows, provinceRaw);
  if (mapped?.official.trim()) return mapped.official.trim();
  return catalogProvince(provinceRaw);
}

export function suggestCity(provinceRaw: string, cityRaw: string, provinceRows: ProvinceSource[], cityRows: CitySource[]): NameSuggestion {
  const mapped = findCity(cityRows, provinceRaw, cityRaw, provinceRows);
  if (mapped?.official.trim()) return { official: mapped.official.trim(), ambiguous: false, fromMapping: true };
  const province = provinceScope(provinceRaw, provinceRows);
  if (!province || !cityRaw.trim()) return { official: null, ambiguous: false, fromMapping: false };
  const candidates = OFFICIAL_CITIES.filter((city) => sameText(city.province, province) && samePlace(city.name, cityRaw));
  const kind = prefixKind(cityRaw);
  const typed = kind ? candidates.filter((city) => city.name.toLowerCase().startsWith(kind)) : candidates;
  if (typed.length === 1) return { official: typed[0].name, ambiguous: false, fromMapping: false };
  if (candidates.length === 1) return { official: candidates[0].name, ambiguous: false, fromMapping: false };
  return { official: null, ambiguous: candidates.length > 1, fromMapping: false };
}

export function citiesInProvince(province: string): string[] {
  return OFFICIAL_CITIES.filter((city) => sameText(city.province, province)).map((city) => city.name);
}
