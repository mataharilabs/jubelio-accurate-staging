import { NextResponse } from "next/server";
import { requireFees } from "@/lib/fees/access";
import { matchFeeOrders } from "@/lib/fees/service";
import { fail } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await requireFees(false);
    const body = await request.json() as { keys?: { noPesanan?: string; orderId?: string }[] };
    const keys = (body.keys ?? [])
      .map((key) => ({ noPesanan: String(key.noPesanan ?? "").trim(), orderId: key.orderId ? String(key.orderId).trim() : undefined }))
      .filter((key) => key.noPesanan);
    if (!keys.length) return NextResponse.json({ matched: [], missing: [] });
    if (keys.length > 8000) return NextResponse.json({ error: "Terlalu banyak pesanan dalam satu permintaan." }, { status: 413 });
    return NextResponse.json(await matchFeeOrders(keys));
  } catch (error) {
    return fail(error);
  }
}
