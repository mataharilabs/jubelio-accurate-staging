import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
    const { id } = await context.params;
    const result = await (await getStore()).recalcBatch(id);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
