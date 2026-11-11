import { NextResponse } from "next/server";
import { listUsers, permissionsFor } from "@/lib/access/store";
import { getStore } from "@/lib/db";
import { fail, requireSession } from "@/lib/http";

export async function GET() {
  try {
    const session = await requireSession();
    const store = await getStore();
    const permissions = await permissionsFor(session).catch(() => []);
    const users = await listUsers().catch(() => []);
    const role = users.find((user) => user.email.toLowerCase() === session.email.toLowerCase())?.roleName ?? "";
    return NextResponse.json({ email: session.email, mode: session.mode, storage: store.mode, permissions, role });
  } catch (error) {
    return fail(error);
  }
}
