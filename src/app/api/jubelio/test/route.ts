import { NextResponse } from "next/server";
import { JubelioClient } from "@/lib/jubelio/client";
import { fail, requirePermission } from "@/lib/http";

export async function GET() {
  try {
    await requirePermission("settings.manage");
    const email = process.env.JUBELIO_EMAIL?.trim() ?? "";
    const masked = email.includes("@") ? `${email.slice(0, 1)}***@${email.split("@")[1]}` : "";
    return NextResponse.json({ configured: Boolean(email && process.env.JUBELIO_PASSWORD), email: masked });
  } catch (error) {
    return fail(error);
  }
}

export async function POST() {
  try {
    await requirePermission("settings.manage");
    const started = Date.now();
    const client = new JubelioClient();
    if (!client.configured()) return NextResponse.json({ ok: false, error: "JUBELIO_EMAIL dan JUBELIO_PASSWORD belum diisi." }, { status: 400 });
    await client.probe();
    return NextResponse.json({ ok: true, ms: Date.now() - started });
  } catch (error) {
    return fail(error);
  }
}
