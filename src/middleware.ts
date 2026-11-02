import { NextResponse, type NextRequest } from "next/server";
import { readSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

const PUBLIC = new Set([
  "/masuk",
  "/atur-sandi",
  "/api/auth/login",
  "/api/auth/mode",
  "/api/auth/recover",
  "/api/auth/accept",
]);

function isAuthCallback(url: URL): boolean {
  const type = (url.searchParams.get("type") ?? "").toLowerCase();
  return url.searchParams.has("code")
    || url.searchParams.has("token_hash")
    || url.searchParams.has("error")
    || url.searchParams.has("error_code")
    || type === "invite"
    || type === "recovery"
    || type === "signup"
    || type === "magiclink";
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico" || pathname.startsWith("/api/cron/")) return NextResponse.next();
  const session = await readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session && !PUBLIC.has(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Sesi habis. Masuk lagi." }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/masuk";
    return NextResponse.redirect(url);
  }
  if (session && pathname === "/masuk" && !isAuthCallback(request.nextUrl)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
