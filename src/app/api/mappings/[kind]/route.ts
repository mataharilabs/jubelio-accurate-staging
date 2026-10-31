import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requireSession } from "@/lib/http";

export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requireSession();
    const { kind } = await context.params;
    const store = await getStore();
    if (kind === "channel") return NextResponse.json(await store.listChannelMaps());
    if (kind === "province") return NextResponse.json(await store.listProvinceMaps());
    if (kind === "city") return NextResponse.json(await store.listCityMaps());
    throw new AppError("Mapping tidak dikenal.");
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requireSession();
    const { kind } = await context.params;
    const body = await request.json();
    const store = await getStore();
    if (kind === "channel") await store.saveChannelMap(body);
    else if (kind === "province") await store.saveProvinceMap(body);
    else if (kind === "city") await store.saveCityMap(body);
    else throw new AppError("Mapping tidak dikenal.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requireSession();
    const { kind } = await context.params;
    if (kind !== "channel") throw new AppError("Hanya mapping channel yang bisa dihapus dari sini.");
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new AppError("Id kosong.");
    await (await getStore()).deleteChannelMap(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
