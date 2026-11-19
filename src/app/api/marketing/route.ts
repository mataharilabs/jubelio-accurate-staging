import { NextResponse } from "next/server";
import { actorLabel, auditQuiet, requireMarketing } from "@/lib/marketing/access";
import { marketingStoreChoices } from "@/lib/marketing/catalog";
import { wibMonth } from "@/lib/marketing/dates";
import { listMarketing, softDeleteMarketing } from "@/lib/marketing/service";
import { fail } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await requireMarketing(false);
    const url = new URL(request.url);
    const month = url.searchParams.get("month") || wibMonth();
    const status = url.searchParams.get("status") === "deleted" || url.searchParams.get("status") === "all" ? url.searchParams.get("status") as "deleted" | "all" : "active";
    const [rows, stores] = await Promise.all([
      listMarketing({ month, status }),
      marketingStoreChoices(),
    ]);
    return NextResponse.json({ rows, stores, month, status });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireMarketing(true);
    const body = (await request.json()) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    const removed = await softDeleteMarketing(ids, await actorLabel(session));
    await auditQuiet({ actorEmail: session.email, action: "marketing.delete", entity: "marketing_spend", entityId: null, before: null, after: { ids, removed } });
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    return fail(error);
  }
}
