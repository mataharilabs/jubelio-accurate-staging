import { AppError } from "@/lib/errors";

export const CUSTOMER_SCOPES = ["customer_view", "customer_save"] as const;

export type CustomerHit = {
  id: string | null;
  name: string;
  customerNo: string;
};

export type CustomerCacheWrite = {
  nameKey: string;
  name: string;
  customerNo: string;
  accurateId: string | null;
};

export type CustomerResolution = {
  customerNo: string;
  customerName: string;
  log: string | null;
  cache: CustomerCacheWrite | null;
};

/** Display name stored on the order: trimmed, internal whitespace collapsed. */
export function buyerName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeCustomerKey(name: string): string {
  return buyerName(name).toLowerCase();
}

/** Stable customer number when Accurate will not auto-number. */
export function deterministicCustomerNo(name: string): string {
  const key = normalizeCustomerKey(name);
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const slug = key.normalize("NFKD").replace(/[^a-z0-9]+/gi, "").toUpperCase().slice(0, 12);
  return `C${slug || "UST"}${hex}`.slice(0, 30);
}

export function missingCustomerScopes(scope: string | null | undefined): string[] {
  const have = new Set((scope ?? "").split(/[\s,]+/).filter(Boolean));
  if (!scope?.trim()) return [...CUSTOMER_SCOPES];
  return CUSTOMER_SCOPES.filter((item) => !have.has(item));
}

export function customerNoRequired(message: string): boolean {
  return /customer\s*no|customerno|nomor pelanggan|no pelanggan/i.test(message);
}

/** Accurate list.do filter. keywords first, then the name field. */
export function customerListQuery(name: string, mode: "keywords" | "name"): string {
  const params = new URLSearchParams();
  params.set("fields", "id,name,no,customerNo");
  params.set("sp.page", "1");
  params.set("sp.pageSize", "50");
  if (mode === "keywords") {
    params.set("filter.keywords.op", "EQUAL");
    params.set("filter.keywords.val", name);
  } else {
    params.set("filter.name.op", "EQUAL");
    params.set("filter.name.val", name);
  }
  return params.toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function readCustomerHits(body: unknown): CustomerHit[] {
  const json = asRecord(body) ?? {};
  if (json.s === false) {
    const detail = Array.isArray(json.d) ? json.d.map(String).join(" ") : text(json.d);
    if (!detail || /not found|tidak ditemukan|no data|tidak ada/i.test(detail)) return [];
    throw new AppError(detail);
  }
  const nested = asRecord(json.d);
  const rows = Array.isArray(json.d) ? json.d : Array.isArray(nested?.list) ? nested.list : Array.isArray(nested?.data) ? nested.data : [];
  return rows.flatMap((row) => {
    const record = asRecord(row);
    if (!record) return [];
    const customerNo = text(record.customerNo || record.no || record.number);
    const name = text(record.name);
    if (!customerNo || !name) return [];
    const id = record.id == null || record.id === "" ? null : String(record.id);
    return [{ id, name, customerNo }];
  });
}

export function readSavedCustomer(body: unknown, fallbackName: string): CustomerHit {
  const json = asRecord(body) ?? {};
  if (json.s === false) {
    const detail = Array.isArray(json.d) ? json.d.map(String).join(" ") : text(json.d);
    throw new AppError(detail || "Accurate menolak pelanggan.");
  }
  const record = asRecord(json.r) ?? asRecord(json.d) ?? {};
  const customerNo = text(record.customerNo || record.no || record.number);
  if (!customerNo) throw new AppError("Accurate menyimpan pelanggan tanpa nomor.");
  const id = record.id == null || record.id === "" ? null : String(record.id);
  return { id, name: text(record.name) || fallbackName, customerNo };
}

export function selectExactCustomer(hits: CustomerHit[], name: string): { hit: CustomerHit; ambiguous: boolean } | null {
  const key = normalizeCustomerKey(name);
  const exact = hits.filter((row) => normalizeCustomerKey(row.name) === key && row.customerNo);
  if (!exact.length) return null;
  return { hit: exact[0], ambiguous: exact.length > 1 };
}

export async function resolveBuyerCustomer(input: {
  buyerName: string;
  defaultCustomerNo: string;
  defaultCustomerName: string;
  cached: { customerNo: string; name: string } | null;
  lookup: (name: string) => Promise<CustomerHit[]>;
  create: (name: string) => Promise<CustomerHit>;
}): Promise<CustomerResolution> {
  const name = buyerName(input.buyerName);
  if (!name) {
    if (!input.defaultCustomerNo) {
      throw new AppError("Pesanan tidak punya nama pembeli dan pelanggan default kosong.");
    }
    const customerName = input.defaultCustomerName || input.defaultCustomerNo;
    return {
      customerNo: input.defaultCustomerNo,
      customerName,
      log: `Nama pembeli kosong. Pakai pelanggan default ${input.defaultCustomerNo} (${customerName}).`,
      cache: null,
    };
  }
  if (input.cached?.customerNo) {
    return {
      customerNo: input.cached.customerNo,
      customerName: input.cached.name || name,
      log: null,
      cache: null,
    };
  }
  const picked = selectExactCustomer(await input.lookup(name), name);
  if (picked) {
    const extra = picked.ambiguous ? " (lebih dari satu nama sama, dipakai yang pertama)" : "";
    return {
      customerNo: picked.hit.customerNo,
      customerName: name,
      log: `Pelanggan Accurate ditemukan: ${name} → ${picked.hit.customerNo}${extra}.`,
      cache: {
        nameKey: normalizeCustomerKey(name),
        name,
        customerNo: picked.hit.customerNo,
        accurateId: picked.hit.id,
      },
    };
  }
  const created = await input.create(name);
  return {
    customerNo: created.customerNo,
    customerName: name,
    log: `Pelanggan Accurate dibuat: ${name} → ${created.customerNo}.`,
    cache: {
      nameKey: normalizeCustomerKey(name),
      name,
      customerNo: created.customerNo,
      accurateId: created.id,
    },
  };
}
