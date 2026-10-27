import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readSessionToken, SESSION_COOKIE, type Session } from "@/lib/auth/session";
import { WorkbookError } from "@/lib/cleanup/read-xlsx";
import { AppError } from "@/lib/errors";

export async function requireSession(): Promise<Session> {
  const jar = await cookies();
  const session = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) throw new AppError("Sesi habis. Masuk lagi.", 401);
  return session;
}

export function fail(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof WorkbookError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error(error);
  return NextResponse.json({ error: "Terjadi kesalahan di server." }, { status: 500 });
}

export async function readUpload(request: Request, field = "file"): Promise<{ name: string; buffer: Buffer }> {
  const form = await request.formData();
  const file = form.get(field);
  if (!(file instanceof File)) throw new AppError("Pilih berkas .xlsx.");
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new AppError("Hanya berkas .xlsx yang didukung.");
  if (file.size > 10 * 1024 * 1024) throw new AppError("Berkas lebih besar dari 10 MB.");
  return { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) };
}
