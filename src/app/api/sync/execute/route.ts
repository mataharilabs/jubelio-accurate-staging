import { NextResponse } from "next/server";
import { executeOrders, type SyncSelection } from "@/lib/sync-service";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as SyncSelection;
    if (!body.batchId) return NextResponse.json({ error: "Batch tidak ada." }, { status: 400 });
    const results = await executeOrders(body, session.email);
    return NextResponse.json({ results });
  } catch (error) {
    return fail(error);
  }
}
