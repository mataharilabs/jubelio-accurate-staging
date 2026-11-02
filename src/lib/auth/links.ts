import { appUrl } from "@/lib/env";

const OTP_TYPES = ["invite", "recovery", "signup", "magiclink", "email"] as const;
export type OtpType = (typeof OTP_TYPES)[number];

export type AuthLink =
  | { kind: "code"; code: string }
  | { kind: "otp"; tokenHash: string; type: OtpType }
  | { kind: "session"; accessToken: string; refreshToken: string };

function params(value: string): URLSearchParams {
  const trimmed = value.replace(/^[?#]/, "");
  return new URLSearchParams(trimmed);
}

function otpType(value: string | null): OtpType | null {
  const type = (value ?? "").toLowerCase();
  return (OTP_TYPES as readonly string[]).includes(type) ? (type as OtpType) : null;
}

/** Invite and recovery links arrive as a PKCE code, a token_hash, or a hash fragment. */
export function parseAuthLink(search: string, hash = ""): AuthLink | null {
  const query = params(search);
  const fragment = params(hash);
  const code = query.get("code")?.trim();
  if (code) return { kind: "code", code };
  const tokenHash = (query.get("token_hash") || fragment.get("token_hash"))?.trim();
  const type = otpType(query.get("type") || fragment.get("type"));
  if (tokenHash && type) return { kind: "otp", tokenHash, type };
  const accessToken = fragment.get("access_token")?.trim();
  const refreshToken = fragment.get("refresh_token")?.trim();
  if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken };
  return null;
}

export function authLinkError(search: string, hash = ""): string | null {
  const query = params(search);
  const fragment = params(hash);
  const code = (query.get("error_code") || fragment.get("error_code") || query.get("error") || fragment.get("error") || "").toLowerCase();
  if (!code) return null;
  if (code.includes("expired") || code === "otp_expired") {
    return "Tautan sudah kedaluwarsa. Minta undangan atau pemulihan sandi yang baru.";
  }
  return "Tautan tidak berlaku. Minta undangan atau pemulihan sandi yang baru.";
}

/** Path to open when /masuk receives an invite or recovery callback. Keeps the query and hash. */
export function setPasswordPath(search: string, hash = ""): string | null {
  if (!parseAuthLink(search, hash) && !authLinkError(search, hash)) return null;
  return `/atur-sandi${search}${hash}`;
}

/** Public origin of this request, then NEXT_PUBLIC_APP_URL. */
export function requestOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.split(",")[0]?.trim();
  if (!host) return appUrl();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
