import { NextResponse } from "next/server";
import { accurateConfigured, supabaseConfigured } from "@/lib/env";

export async function GET() {
  const supabase = supabaseConfigured();
  return NextResponse.json({
    mode: supabase ? "supabase" : "demo",
    emailHint: supabase ? null : process.env.DEMO_ADMIN_EMAIL?.trim() || null,
    accurateConfigured: accurateConfigured(),
  });
}
