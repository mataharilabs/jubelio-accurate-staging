import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { fail, requirePermission } from "@/lib/http";
import { executeSync } from "@/lib/sync-service";

export async function POST(request: Request) {
  try {
    const session = await requirePermission("sync.execute");
    const body = (await request.json()) as { nos?: string[] };
    const result = await executeSync(body.nos ?? [], session.email);
    await recordAudit({ actorEmail: session.email, action: "sync.execute", entity: "sync_batch", entityId: result.batch.id, before: null, after: { count: body.nos?.length ?? 0 } });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
