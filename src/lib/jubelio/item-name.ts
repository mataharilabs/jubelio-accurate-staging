/** Pull a display name out of a Jubelio item payload. Callers must not log the payload. */
export function itemNameFromPayload(body: unknown): string | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const nested = Array.isArray(record.data) ? record.data[0] : record.data;
  const row = (nested && typeof nested === "object" ? nested : record) as Record<string, unknown>;
  const name = row.item_name ?? row.name ?? row.description;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
