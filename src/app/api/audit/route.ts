import { NextResponse } from "next/server";
import { listAudit } from "@/lib/access/store";
import { fail, requirePermission } from "@/lib/http";

export async function GET() {
  try {
    await requirePermission("audit.view");
    return NextResponse.json({ entries: await listAudit() });
  } catch (error) {
    return fail(error);
  }
}
