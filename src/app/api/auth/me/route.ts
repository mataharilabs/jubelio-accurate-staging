import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    const session = await requireSession();
    const store = await getStore();
    return NextResponse.json({ email: session.email, mode: session.mode, storage: store.mode });
  } catch (error) {
    return fail(error);
  }
}
