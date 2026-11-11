import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { getStore } from "@/lib/db";
import { buildManualOrder, type ManualOrderInput } from "@/lib/domain/manual-order";
import { AppError } from "@/lib/errors";
import { fail, requireMaster } from "@/lib/http";
import { listProducts } from "@/lib/products/service";

export async function POST(request: Request) {
  try {
    const session = await requireMaster("orders.edit");
    const body = await request.json() as ManualOrderInput;
    const products = await listProducts({ active: "active" });
    const known = new Map(products.filter((row) => row.active !== false).map((row) => [row.sku, row.name]));
    const version = buildManualOrder(body, known, { createdAt: new Date().toISOString(), createdBy: session.email });
    await (await getStore()).createManualOrder(version);
    await recordAudit({
      actorEmail: session.email,
      action: "order.manual",
      entity: "order",
      entityId: version.noPesanan,
      before: null,
      after: {
        source: "manual",
        tanggal: version.tanggal,
        channel: version.channel,
        storeName: version.storeName,
        status: version.status,
        customerName: version.customerName,
        province: version.province,
        city: version.city,
        lines: version.lines.map((line) => ({ sku: line.sku, qty: line.qty, unitPrice: line.unitPrice, unitDiskon: line.unitDiskon })),
        revenue: version.revenue,
      },
    });
    return NextResponse.json({ ok: true, noPesanan: version.noPesanan, source: "manual" });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    return fail(error);
  }
}
