import { NextResponse } from "next/server";
import { permissionsFor } from "@/lib/access/store";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    const session = await requireSession();
    const store = await getStore();
    const permissions = await permissionsFor(session).catch(() => []);
    return NextResponse.json({ email: session.email, mode: session.mode, storage: store.mode, permissions });
  } catch (error) {
    return fail(error);
  }
}
