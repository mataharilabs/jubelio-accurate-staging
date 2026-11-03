import { createHmac } from "node:crypto";
import { AppError } from "@/lib/errors";

const ACCOUNT = "https://account.accurate.id";

export type AccurateFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function accurateApiEnv() {
  return {
    token: process.env.ACCURATE_API_TOKEN?.trim() ?? "",
    signatureKey: process.env.ACCURATE_SIGNATURE_KEY?.trim() ?? "",
  };
}

export function accurateApiConfigured(): boolean {
  const env = accurateApiEnv();
  return Boolean(env.token && env.signatureKey);
}

/** Base64(HMAC-SHA256(timestamp, signatureKey)). The secret stays off the returned value. */
export function signAccurateTimestamp(timestamp: string, signatureKey: string): string {
  return createHmac("sha256", signatureKey).update(timestamp).digest("base64");
}

export function accurateReadHeaders(token: string, signatureKey: string, timestamp: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Api-Timestamp": timestamp,
    "X-Api-Signature": signAccurateTimestamp(timestamp, signatureKey),
  };
}

export type NearestCost = { found: boolean; unitCost: number | null; itemId: string | null; message: string | null };

type Envelope = { s?: boolean; d?: unknown };

export function readNearestCost(body: unknown): NearestCost {
  const json = (body && typeof body === "object" ? body : {}) as Envelope;
  if (json.s === false) {
    const message = typeof json.d === "string" ? json.d : "Accurate menolak item ini.";
    const missing = /not found|tidak ditemukan|no data/i.test(message);
    return { found: false, unitCost: null, itemId: null, message: missing ? "Tidak ada di Accurate" : message };
  }
  const data = json.d && typeof json.d === "object" ? json.d as Record<string, unknown> : {};
  const raw = data.unitCost ?? data.cost ?? data.nearestCost ?? data.hpp ?? null;
  const unitCost = raw == null || raw === "" ? null : Number(raw);
  const itemId = data.id == null ? null : String(data.id);
  if (unitCost == null || !Number.isFinite(unitCost)) {
    return { found: true, unitCost: null, itemId, message: "Accurate tidak mengirim HPP." };
  }
  return { found: true, unitCost, itemId, message: null };
}

export function readDatabaseHost(body: unknown): string {
  const json = (body && typeof body === "object" ? body : {}) as Envelope & { host?: string };
  const data = json.d && typeof json.d === "object" ? json.d as Record<string, unknown> : {};
  const database = data.database && typeof data.database === "object" ? data.database as Record<string, unknown> : {};
  const host = String(database.host || data.host || json.host || "").trim();
  if (!host) throw new AppError("Accurate belum terhubung.");
  return host.replace(/\/$/, "");
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

async function send(fetchImpl: AccurateFetch, url: string, init: RequestInit, attempt = 0): Promise<Response> {
  const response = await fetchImpl(url, { ...init, redirect: "manual" });
  if (response.status === 308 || response.status === 307 || response.status === 301 || response.status === 302) {
    const next = response.headers.get("location");
    if (!next || attempt > 2) throw new AppError(`Accurate mengalihkan permintaan tanpa tujuan (${response.status}).`);
    return send(fetchImpl, new URL(next, url).toString(), init, attempt + 1);
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    return send(fetchImpl, url, init, attempt + 1);
  }
  return response;
}

export async function openAccurateHost(fetchImpl: AccurateFetch, token: string, signatureKey: string, now = new Date()): Promise<string> {
  const timestamp = now.toISOString();
  const response = await send(fetchImpl, `${ACCOUNT}/api/api-token.do`, {
    method: "POST",
    headers: accurateReadHeaders(token, signatureKey, timestamp),
  });
  const body = await readJson(response);
  if (!response.ok || (body && typeof body === "object" && (body as Envelope).s === false)) {
    throw new AppError("Accurate belum terhubung.");
  }
  return readDatabaseHost(body);
}

export async function fetchNearestCost(fetchImpl: AccurateFetch, host: string, token: string, signatureKey: string, sku: string, now = new Date()): Promise<NearestCost> {
  const timestamp = now.toISOString();
  const url = new URL("/accurate/api/item/get-nearest-cost.do", host.startsWith("http") ? host : `https://${host}`);
  url.searchParams.set("itemNo", sku);
  const response = await send(fetchImpl, url.toString(), {
    method: "GET",
    headers: accurateReadHeaders(token, signatureKey, timestamp),
  });
  const body = await readJson(response);
  if (response.status === 404) return { found: false, unitCost: null, itemId: null, message: "Tidak ada di Accurate" };
  if (!response.ok) throw new AppError(`Accurate menolak permintaan HPP (${response.status}).`);
  const parsed = readNearestCost(body);
  if (parsed.unitCost != null || !parsed.found) return parsed;
  const detail = new URL("/accurate/api/item/detail.do", url.origin);
  detail.searchParams.set("no", sku);
  const fallback = await send(fetchImpl, detail.toString(), {
    method: "GET",
    headers: accurateReadHeaders(token, signatureKey, timestamp),
  });
  if (!fallback.ok) return parsed;
  return readNearestCost(await readJson(fallback));
}

export function assertAccurateReadOnly(method: string) {
  if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "POST") {
    throw new AppError("Accurate hanya boleh dibaca.");
  }
}
