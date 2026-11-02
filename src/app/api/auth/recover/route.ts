import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { requestOrigin } from "@/lib/auth/links";
import { supabaseAnonKey, supabaseConfigured, supabaseUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { fail } from "@/lib/http";

export async function POST(request: Request) {
  try {
    if (!supabaseConfigured()) throw new AppError("Pemulihan sandi hanya tersedia saat Supabase Auth dipakai.");
    const body = (await request.json()) as { email?: string };
    const email = body.email?.trim() ?? "";
    if (!email) throw new AppError("Isi email.");
    const supabase = createClient(supabaseUrl(), supabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const redirectTo = `${requestOrigin(request)}/masuk`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new AppError("Tautan pemulihan belum terkirim. Coba lagi.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
