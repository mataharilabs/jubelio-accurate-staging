import { NextResponse } from "next/server";
import { actorLabel, requireFees } from "@/lib/fees/access";
import { applyPayments, deletePayments, listPayments, lookupPaymentOrder } from "@/lib/fees/service";
import type { PaymentDraft } from "@/lib/fees/types";
import { fail } from "@/lib/http";
import { clampPageSize } from "@/lib/page-size";

export async function GET(request: Request) {
  try {
    await requireFees(false);
    const url = new URL(request.url);
    const noPesanan = url.searchParams.get("noPesanan");
    if (noPesanan) return NextResponse.json(await lookupPaymentOrder(noPesanan.trim()));
    const page = Number(url.searchParams.get("page") ?? "0");
    return NextResponse.json(await listPayments({
      q: url.searchParams.get("q") ?? "",
      page: Number.isFinite(page) ? page : 0,
      pageSize: clampPageSize(url.searchParams.get("limit"), 25),
    }));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireFees(true);
    const body = await request.json() as { source?: string; importId?: string; rows?: PaymentDraft[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ error: "Tidak ada pembayaran untuk disimpan." }, { status: 400 });
    if (rows.length > 1000) return NextResponse.json({ error: "Kirim pembayaran dalam kelompok yang lebih kecil." }, { status: 413 });
    const source = body.source === "template" ? "template" : "manual";
    const result = await applyPayments({ actor: await actorLabel(session), source, importId: body.importId, rows });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireFees(true);
    const body = await request.json() as { ids?: string[] };
    const ids = (body.ids ?? []).map(String).filter(Boolean);
    if (!ids.length) return NextResponse.json({ error: "Pilih pembayaran yang dihapus." }, { status: 400 });
    return NextResponse.json({ ok: true, ...(await deletePayments(await actorLabel(session), ids)) });
  } catch (error) {
    return fail(error);
  }
}
