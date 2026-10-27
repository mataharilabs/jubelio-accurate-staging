import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl } from "@/lib/accurate/client";
import { sessionCookieOptions } from "@/lib/auth/session";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    const state = crypto.randomUUID();
    const jar = await cookies();
    jar.set("acn_oauth_state", state, { ...sessionCookieOptions(), maxAge: 60 * 10 });
    return NextResponse.redirect(authorizeUrl(state));
  } catch (error) {
    return fail(error);
  }
}
