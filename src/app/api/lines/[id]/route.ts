import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import type { LinePatch } from "@/lib/db/types";
import { fail, requireSession } from "@/lib/http";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
    const { id } = await context.params;
    const patch = (await request.json()) as LinePatch;
    const line = await (await getStore()).updateLine(id, patch);
    return NextResponse.json(line);
  } catch (error) {
    return fail(error);
  }
}
