const SYNONYMS: [RegExp, string][] = [
  [/\bshop\b/g, "store"],
  [/\btoko\b/g, "store"],
];

export function canonStore(value: string): string {
  const text = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return SYNONYMS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text).replace(/\s+/g, " ").trim();
}

export function matchStore(raw: string, stores: string[]): { match: string | null; ambiguous: string[] } {
  const target = canonStore(raw);
  if (!target) return { match: null, ambiguous: [] };
  const exact = stores.filter((store) => canonStore(store) === target);
  if (exact.length === 1) return { match: exact[0], ambiguous: [] };
  if (exact.length > 1) return { match: null, ambiguous: exact };
  const loose = stores.filter((store) => {
    const canon = canonStore(store);
    return canon.length > 3 && (canon.includes(target) || target.includes(canon));
  });
  if (loose.length === 1) return { match: loose[0], ambiguous: [] };
  return { match: null, ambiguous: loose };
}
