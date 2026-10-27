import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = (await request.json()) as { ids?: string[] };
    if (!body.ids?.length) throw new AppError("Pilih baris yang akan dihapus.");
    const result = await (await getStore()).deleteLines(body.ids);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
