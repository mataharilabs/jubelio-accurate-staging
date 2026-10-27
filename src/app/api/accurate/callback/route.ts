import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/accurate/client";
import { getStore } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { fail, requireSession } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const jar = await cookies();
    const expected = jar.get("acn_oauth_state")?.value;
    jar.set("acn_oauth_state", "", { path: "/", maxAge: 0 });
    const back = new URL("/pengaturan", appUrl());
    if (!code || !state || state !== expected) {
      back.searchParams.set("accurate", "gagal");
      return NextResponse.redirect(back);
    }
    const tokens = await exchangeCode(code);
    await (await getStore()).saveTokens(tokens);
    back.searchParams.set("accurate", "terhubung");
    return NextResponse.redirect(back);
  } catch (error) {
    return fail(error);
  }
}
