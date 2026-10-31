import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    await requireSession();
    return NextResponse.json(await (await getStore()).meta());
  } catch (error) {
    return fail(error);
  }
}
