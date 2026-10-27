export const SESSION_COOKIE = "acn_session";
const TWELVE_HOURS = 1000 * 60 * 60 * 12;

export type Session = {
  email: string;
  mode: "demo" | "supabase";
  exp: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(signature));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authSecret(): string | null {
  const secret = process.env.AUTH_SECRET?.trim();
  return secret || null;
}

export async function createSessionToken(email: string, mode: Session["mode"]): Promise<string> {
  const secret = authSecret();
  if (!secret) throw new Error("AUTH_SECRET belum diisi.");
  const payload: Session = { email, mode, exp: Date.now() + TWELVE_HOURS };
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await sign(secret, body)}`;
}

export async function readSessionToken(token: string | undefined | null): Promise<Session | null> {
  const secret = authSecret();
  if (!secret || !token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = await sign(secret, body);
  if (!safeEqual(signature, expected)) return null;
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(body));
    const session = JSON.parse(json) as Session;
    if (!session.email || !session.exp || session.exp < Date.now()) return null;
    if (session.mode !== "demo" && session.mode !== "supabase") return null;
    return session;
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.NEXT_PUBLIC_APP_URL ?? "").startsWith("https://"),
    path: "/",
    maxAge: TWELVE_HOURS / 1000,
  };
}
