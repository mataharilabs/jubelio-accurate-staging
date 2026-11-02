import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { OtpType } from "@/lib/auth/links";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { supabaseAnonKey, supabaseConfigured, supabaseUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { fail } from "@/lib/http";

const OTP_TYPES = new Set<OtpType>(["invite", "recovery", "signup", "magiclink", "email"]);

export async function POST(request: Request) {
  try {
    if (!supabaseConfigured()) throw new AppError("Supabase Auth belum dihubungkan.", 400);
    const body = (await request.json()) as {
      password?: string;
      code?: string;
      tokenHash?: string;
      type?: string;
      accessToken?: string;
      refreshToken?: string;
    };
    const password = body.password ?? "";
    if (password.length < 8) throw new AppError("Sandi minimal 8 karakter.");

    const supabase = createClient(supabaseUrl(), supabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    if (body.code?.trim()) {
      const { error } = await supabase.auth.exchangeCodeForSession(body.code.trim());
      if (error) throw new AppError("Tautan undangan atau pemulihan tidak berlaku. Minta yang baru.");
    } else if (body.tokenHash?.trim() && body.type && OTP_TYPES.has(body.type as OtpType)) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: body.tokenHash.trim(), type: body.type as OtpType });
      if (error) throw new AppError("Tautan undangan atau pemulihan tidak berlaku. Minta yang baru.");
    } else if (body.accessToken?.trim() && body.refreshToken?.trim()) {
      const { error } = await supabase.auth.setSession({
        access_token: body.accessToken.trim(),
        refresh_token: body.refreshToken.trim(),
      });
      if (error) throw new AppError("Tautan undangan atau pemulihan tidak berlaku. Minta yang baru.");
    } else {
      throw new AppError("Tautan tidak lengkap. Buka ulang tautan dari email.");
    }

    const updated = await supabase.auth.updateUser({ password });
    if (updated.error || !updated.data.user?.email) {
      throw new AppError(updated.error?.message || "Sandi belum tersimpan.");
    }

    const email = updated.data.user.email;
    const token = await createSessionToken(email, "supabase");
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, sessionCookieOptions(request));
    return NextResponse.json({ ok: true, email });
  } catch (error) {
    return fail(error);
  }
}
