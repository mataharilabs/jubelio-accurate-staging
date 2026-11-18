import {
  customerListQuery,
  customerNoRequired,
  deterministicCustomerNo,
  readCustomerHits,
  readSavedCustomer,
  selectExactCustomer,
  type CustomerHit,
} from "@/lib/accurate/customer";
import {
  deleteInvoiceUrl,
  encodeBody,
  invoiceListQuery,
  invoiceUrl,
  readExistingInvoice,
  SALES_INVOICE_DETAIL_PATH,
  SALES_INVOICE_LIST_PATH,
  type ExistingInvoice,
  type InvoiceDraft,
} from "@/lib/accurate/invoice";
import type { AccurateTokens } from "@/lib/db/types";
import { accurateEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

const ACCOUNT = "https://account.accurate.id";
export const ACCURATE_SCOPE = "sales_invoice_view sales_invoice_save customer_view customer_save warehouse_view branch_view";
export const CUSTOMER_LIST_PATH = "/accurate/api/customer/list.do";
export const CUSTOMER_SAVE_PATH = "/accurate/api/customer/save.do";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  user?: { email?: string };
};

type AccurateEnvelope = {
  s?: boolean;
  d?: unknown;
  host?: string;
  session?: string;
  r?: { id?: number | string; no?: string; number?: string };
};

function basicAuth(): string {
  const { clientId, clientSecret } = accurateEnv();
  if (!clientId || !clientSecret) {
    throw new AppError("ACCURATE_CLIENT_ID dan ACCURATE_CLIENT_SECRET belum diisi.");
  }
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function postForm(url: string, body: URLSearchParams, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
  });
}

function tokenFromResponse(json: TokenResponse, previous: AccurateTokens | null): AccurateTokens {
  if (!json.access_token) {
    throw new AppError(json.error_description || json.error || "Accurate tidak mengembalikan access token.");
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 1295999;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || previous?.refreshToken || null,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: json.scope ?? previous?.scope ?? null,
    userEmail: json.user?.email ?? previous?.userEmail ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export function authorizeUrl(state: string): string {
  const { clientId, redirectUri } = accurateEnv();
  if (!clientId) throw new AppError("ACCURATE_CLIENT_ID belum diisi.");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ACCURATE_SCOPE,
    state,
  });
  return `${ACCOUNT}/oauth/authorize?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<AccurateTokens> {
  const { redirectUri } = accurateEnv();
  const response = await postForm(
    `${ACCOUNT}/oauth/token`,
    new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    { Authorization: basicAuth() },
  );
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    throw new AppError(json.error_description || json.error || "Gagal menukar kode OAuth Accurate.");
  }
  return tokenFromResponse(json, null);
}

export async function refreshTokens(current: AccurateTokens): Promise<AccurateTokens> {
  if (!current.refreshToken) {
    throw new AppError("Token Accurate kedaluwarsa dan tidak punya refresh token. Hubungkan ulang dari Pengaturan.");
  }
  const response = await postForm(
    `${ACCOUNT}/oauth/token`,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken }),
    { Authorization: basicAuth() },
  );
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    throw new AppError(json.error_description || json.error || "Gagal memperbarui token Accurate.");
  }
  return tokenFromResponse(json, current);
}

export function tokenNeedsRefresh(tokens: AccurateTokens): boolean {
  if (!tokens.expiresAt) return false;
  return new Date(tokens.expiresAt).getTime() - Date.now() < 1000 * 60 * 60 * 24;
}

async function accurateGet(url: string, accessToken: string, session?: string): Promise<AccurateEnvelope> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (session) headers["X-Session-ID"] = session;
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(45000) });
  const json = (await response.json().catch(() => ({}))) as AccurateEnvelope;
  if (!response.ok) {
    throw new AppError(`Accurate menolak permintaan (${response.status}).`);
  }
  return json;
}

export async function listDatabases(accessToken: string): Promise<{ id: string; alias: string }[]> {
  const json = await accurateGet(`${ACCOUNT}/api/db-list.do`, accessToken);
  const rows = Array.isArray(json.d) ? json.d : [];
  return rows
    .map((row) => {
      const record = row && typeof row === "object" ? (row as { id?: number | string; alias?: string }) : {};
      return { id: record.id == null ? "" : String(record.id), alias: record.alias || "" };
    })
    .filter((row) => row.id);
}

export async function openDatabase(accessToken: string, databaseId: string): Promise<{ host: string; session: string }> {
  const json = await accurateGet(`${ACCOUNT}/api/open-db.do?id=${encodeURIComponent(databaseId)}`, accessToken);
  if (!json.s || !json.host || !json.session) {
    const detail = Array.isArray(json.d) ? json.d.map(String).join(" ") : "Gagal membuka database Accurate.";
    throw new AppError(detail);
  }
  return { host: json.host, session: json.session };
}

export async function saveSalesInvoice(
  accessToken: string,
  host: string,
  session: string,
  draft: InvoiceDraft,
): Promise<{ accurateId: string | null; accurateNumber: string | null; response: AccurateEnvelope }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(draft.fields)) params.append(key, value);
  const response = await postForm(invoiceUrl(host), params, {
    Authorization: `Bearer ${accessToken}`,
    "X-Session-ID": session,
  });
  const json = (await response.json().catch(() => ({}))) as AccurateEnvelope;
  if (!response.ok || json.s === false) {
    const detail = Array.isArray(json.d) ? json.d.map(String).join(" ") : `Accurate menolak faktur (${response.status}).`;
    const error = new AppError(detail || "Accurate menolak faktur.");
    (error as AppError & { response?: AccurateEnvelope }).response = json;
    throw error;
  }
  const number = json.r?.no || json.r?.number || draft.fields.number || null;
  const id = json.r?.id == null ? null : String(json.r.id);
  return { accurateId: id, accurateNumber: number, response: json };
}

function invoiceApiUrl(host: string, path: string, query: string): string {
  return `${host.replace(/\/$/, "")}${path}?${query}`;
}

/**
 * Find a sales invoice by its number.
 * detail.do?number= is the documented alternative to id. The spec also marks id as required,
 * so a rejection falls through to list.do filter.number.
 */
export async function findSalesInvoiceByNumber(
  accessToken: string,
  host: string,
  session: string,
  number: string,
): Promise<ExistingInvoice | null> {
  const detailUrl = invoiceApiUrl(host, SALES_INVOICE_DETAIL_PATH, `number=${encodeURIComponent(number)}`);
  try {
    const detail = await accurateGet(detailUrl, accessToken, session);
    const hit = readExistingInvoice(detail, number);
    if (hit) return hit;
  } catch {
    // detail.do may require id; list.do is the documented number filter.
  }
  const listUrl = invoiceApiUrl(host, SALES_INVOICE_LIST_PATH, invoiceListQuery(number));
  const listed = await accurateGet(listUrl, accessToken, session);
  return readExistingInvoice(listed, number);
}

export async function deleteSalesInvoice(
  accessToken: string,
  host: string,
  session: string,
  accurateId: string,
): Promise<{ response: AccurateEnvelope }> {
  const response = await postForm(deleteInvoiceUrl(host), new URLSearchParams({ id: accurateId }), {
    Authorization: `Bearer ${accessToken}`,
    "X-Session-ID": session,
  });
  const json = (await response.json().catch(() => ({}))) as AccurateEnvelope;
  if (!response.ok || json.s === false) {
    const detail = Array.isArray(json.d) ? json.d.map(String).join(" ") : `Accurate menolak penghapusan faktur (${response.status}).`;
    throw new AppError(detail || "Accurate menolak penghapusan faktur.");
  }
  return { response: json };
}

function customerUrl(host: string, path: string): string {
  return `${host.replace(/\/$/, "")}${path}`;
}

async function listCustomers(accessToken: string, host: string, session: string, name: string, mode: "keywords" | "name"): Promise<CustomerHit[]> {
  const json = await accurateGet(`${customerUrl(host, CUSTOMER_LIST_PATH)}?${customerListQuery(name, mode)}`, accessToken, session);
  return readCustomerHits(json);
}

/** Exact name match via filter.keywords, then filter.name when keywords miss. */
export async function findCustomersByName(accessToken: string, host: string, session: string, name: string): Promise<CustomerHit[]> {
  let hits: CustomerHit[] = [];
  let keywordError: unknown = null;
  try {
    hits = await listCustomers(accessToken, host, session, name, "keywords");
  } catch (error) {
    keywordError = error;
  }
  if (selectExactCustomer(hits, name)) return hits;
  try {
    const byName = await listCustomers(accessToken, host, session, name, "name");
    const seen = new Set(hits.map((row) => `${row.customerNo}\n${row.name}`));
    return [...hits, ...byName.filter((row) => !seen.has(`${row.customerNo}\n${row.name}`))];
  } catch (error) {
    if (hits.length) return hits;
    throw keywordError ?? error;
  }
}

export async function saveCustomer(accessToken: string, host: string, session: string, name: string, customerNo?: string): Promise<CustomerHit> {
  const params = new URLSearchParams();
  params.append("name", name);
  if (customerNo) params.append("customerNo", customerNo);
  const response = await postForm(customerUrl(host, CUSTOMER_SAVE_PATH), params, {
    Authorization: `Bearer ${accessToken}`,
    "X-Session-ID": session,
  });
  const json = (await response.json().catch(() => ({}))) as AccurateEnvelope;
  if (!response.ok || json.s === false) {
    const detail = Array.isArray(json.d) ? json.d.map(String).join(" ") : `Accurate menolak pelanggan (${response.status}).`;
    throw new AppError(detail || "Accurate menolak pelanggan.");
  }
  return readSavedCustomer(json, name);
}

/** Let Accurate auto-number. If the company requires a number, send a deterministic one. */
export async function createCustomer(accessToken: string, host: string, session: string, name: string): Promise<CustomerHit> {
  try {
    return await saveCustomer(accessToken, host, session, name);
  } catch (error) {
    if (!(error instanceof AppError) || !customerNoRequired(error.message)) throw error;
    const customerNo = deterministicCustomerNo(name);
    try {
      return await saveCustomer(accessToken, host, session, name, customerNo);
    } catch (retryError) {
      const again = await findCustomersByName(accessToken, host, session, name).catch(() => []);
      const existing = selectExactCustomer(again, name);
      if (existing) return existing.hit;
      throw retryError;
    }
  }
}

export function draftWithHost(draft: InvoiceDraft, host: string, sessionReady: boolean): InvoiceDraft {
  return {
    ...draft,
    endpoint: invoiceUrl(host),
    headers: {
      ...draft.headers,
      "X-Session-ID": sessionReady ? "<session aktif>" : draft.headers["X-Session-ID"],
    },
    body: encodeBody(draft.fields),
  };
}
