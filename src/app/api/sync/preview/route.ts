import { NextResponse } from "next/server";
import { previewOrders, type SyncSelection } from "@/lib/sync-service";
import { fail, requireSession } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = (await request.json()) as SyncSelection;
    if (!body.batchId) return NextResponse.json({ error: "Batch tidak ada." }, { status: 400 });
    const orders = await previewOrders(body);
    return NextResponse.json({ orders });
  } catch (error) {
    return fail(error);
  }
}
