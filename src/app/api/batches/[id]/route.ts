import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    await requireSession();
    const { id } = await context.params;
    const bundle = await (await getStore()).getBatchBundle(id);
    if (!bundle) return NextResponse.json({ error: "Batch tidak ditemukan." }, { status: 404 });
    return NextResponse.json(bundle);
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    await requireSession();
    const { id } = await context.params;
    await (await getStore()).deleteBatch(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
