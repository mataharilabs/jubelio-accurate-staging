import { NextResponse } from "next/server";
import { listRoles, listUsers, recordAudit, saveRole, saveUser } from "@/lib/access/store";
import { fail, requirePermission } from "@/lib/http";

export async function GET() {
  try {
    await requirePermission("users.manage");
    const [users, roles] = await Promise.all([listUsers(), listRoles()]);
    return NextResponse.json({ users, roles });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePermission("users.manage");
    const body = (await request.json()) as { email?: string; displayName?: string; roleId?: string; active?: boolean; id?: string };
    if (!body.email || !body.roleId) return NextResponse.json({ error: "Email dan peran wajib diisi." }, { status: 400 });
    await saveUser({ id: body.id, email: body.email, displayName: body.displayName, roleId: body.roleId, active: body.active });
    await recordAudit({ actorEmail: session.email, action: "user.save", entity: "app_user", entityId: body.email, before: null, after: body });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requirePermission("roles.manage");
    const body = (await request.json()) as { id?: string; name?: string; permissions?: string[] };
    if (!body.name) return NextResponse.json({ error: "Nama peran wajib diisi." }, { status: 400 });
    await saveRole({ id: body.id, name: body.name, permissions: body.permissions ?? [] });
    await recordAudit({ actorEmail: session.email, action: "role.save", entity: "role", entityId: body.id ?? body.name, before: null, after: body });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
