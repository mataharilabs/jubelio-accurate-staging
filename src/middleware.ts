import { NextResponse, type NextRequest } from "next/server";
import { readSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

const PUBLIC = new Set(["/masuk", "/api/auth/login", "/api/auth/mode"]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") return NextResponse.next();
  const session = await readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session && !PUBLIC.has(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Sesi habis. Masuk lagi." }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/masuk";
    return NextResponse.redirect(url);
  }
  if (session && pathname === "/masuk") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
