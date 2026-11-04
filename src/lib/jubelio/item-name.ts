/** Pull a display name out of a Jubelio item payload. Callers must not log the payload. */
export function itemNameFromPayload(body: unknown): string | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const nested = Array.isArray(record.data) ? record.data[0] : record.data;
  const row = (nested && typeof nested === "object" ? nested : record) as Record<string, unknown>;
  const name = row.item_name ?? row.name ?? row.description;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export type ItemIdentity = { id: number; name: string | null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rowsOf(body: unknown): Record<string, unknown>[] {
  const record = asRecord(body);
  if (!record) return [];
  if (Array.isArray(record.data)) return record.data.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
  const nested = asRecord(record.data);
  return [nested ?? record];
}

function numericId(value: unknown): number | null {
  const id = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Identity from one item detail. Only id and name leave this function. */
export function itemIdentityFromDetail(body: unknown): ItemIdentity | null {
  const row = rowsOf(body)[0];
  if (!row) return null;
  const id = numericId(row.item_id ?? row.id);
  if (id == null) return null;
  return { id, name: itemNameFromPayload(row) };
}

/** Exact item_code match from a list payload. Other fields are dropped. */
export function matchItemByCode(body: unknown, sku: string): ItemIdentity | null {
  const wanted = sku.trim();
  if (!wanted) return null;
  for (const row of rowsOf(body)) {
    const code = typeof row.item_code === "string" ? row.item_code.trim() : "";
    if (code !== wanted) continue;
    const id = numericId(row.item_id ?? row.id);
    if (id == null) continue;
    return { id, name: itemNameFromPayload(row) };
  }
  return null;
}

export type ProductSeed = { sku: string; lineName: string; itemId: number | null };

type SeedItem = {
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  description?: string | null;
  is_bundle?: boolean;
};

type SeedBundle = { bundles?: Array<{ item_id?: number | null; item_code?: string | null; item_name?: string | null }> };

/** SKU → item id from the order that is already in memory. Bundle SKUs use the component id. */
export function productSeedsFromOrders(orders: Array<{ items?: SeedItem[] }>, bundles: Map<number, SeedBundle>): ProductSeed[] {
  const map = new Map<string, ProductSeed>();
  const put = (sku: string | null | undefined, lineName: string | null | undefined, itemId: number | null | undefined) => {
    const key = sku?.trim() ?? "";
    if (!key || map.has(key)) return;
    map.set(key, { sku: key, lineName: (lineName ?? "").trim(), itemId: itemId && itemId > 0 ? itemId : null });
  };
  for (const order of orders) {
    for (const item of order.items ?? []) {
      if (item.is_bundle) {
        const components = item.item_id == null ? [] : (bundles.get(item.item_id)?.bundles ?? []);
        if (!components.length) {
          put(item.item_code, item.description || item.item_name, item.item_id);
          continue;
        }
        for (const component of components) put(component.item_code, component.item_name, component.item_id);
      } else {
        put(item.item_code, item.description || item.item_name, item.item_id);
      }
    }
  }
  return [...map.values()];
}

export function chooseProductName(input: { masterName: string | null; lineName?: string | null; existingName?: string | null }): { name: string; source: "item" | "line" } {
  const master = input.masterName?.trim() ?? "";
  if (master) return { name: master, source: "item" };
  const existing = input.existingName?.trim() ?? "";
  const line = input.lineName?.trim() ?? "";
  return { name: existing || line, source: "line" };
}

/** A name typed in the app (updated_by is a person) is left alone. */
export function mayReplaceName(updatedBy: string | null | undefined): boolean {
  return updatedBy == null || updatedBy === "" || updatedBy === "jubelio";
}
