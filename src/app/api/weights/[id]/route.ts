import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    await requireSession();
    const { id } = await context.params;
    const body = (await request.json()) as { bundleKey?: string; bobot?: number };
    const weight = await (await getStore()).updateWeight(id, {
      bundleKey: body.bundleKey,
      bobot: body.bobot == null ? undefined : Number(body.bobot),
    });
    return NextResponse.json(weight);
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    await requireSession();
    const { id } = await context.params;
    await (await getStore()).deleteWeight(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
