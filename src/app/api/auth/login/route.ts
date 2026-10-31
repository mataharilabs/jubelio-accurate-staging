import { createHash, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { supabaseAnonKey, supabaseConfigured, supabaseUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { fail } from "@/lib/http";

function same(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";
    if (!email || !password) throw new AppError("Isi email dan sandi.");

    let mode: "demo" | "supabase" = "demo";
    if (supabaseConfigured()) {
      const supabase = createClient(supabaseUrl(), supabaseAnonKey(), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new AppError("Email atau sandi tidak cocok.", 401);
      mode = "supabase";
    } else {
      const expectedEmail = process.env.DEMO_ADMIN_EMAIL?.trim() ?? "";
      const expectedPassword = process.env.DEMO_ADMIN_PASSWORD ?? "";
      if (!expectedEmail || !expectedPassword) {
        throw new AppError("Mode lokal membutuhkan DEMO_ADMIN_EMAIL dan DEMO_ADMIN_PASSWORD.", 500);
      }
      if (!same(email.toLowerCase(), expectedEmail.toLowerCase()) || !same(password, expectedPassword)) {
        throw new AppError("Email atau sandi tidak cocok.", 401);
      }
    }

    const token = await createSessionToken(email, mode);
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, sessionCookieOptions());
    return NextResponse.json({ ok: true, email, mode });
  } catch (error) {
    return fail(error);
  }
}
