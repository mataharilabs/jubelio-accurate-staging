import { deleteInvoiceUrl, encodeBody, invoiceUrl, type InvoiceDraft } from "@/lib/accurate/invoice";
import type { AccurateTokens } from "@/lib/db/types";
import { accurateEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

const ACCOUNT = "https://account.accurate.id";
export const ACCURATE_SCOPE = "sales_invoice_view sales_invoice_save";

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
  const number = json.r?.no || json.r?.number || null;
  const id = json.r?.id == null ? null : String(json.r.id);
  return { accurateId: id, accurateNumber: number, response: json };
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
