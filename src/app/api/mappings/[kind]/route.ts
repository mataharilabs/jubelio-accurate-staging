import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";
import { closeCityReviews, closeProvinceReviews } from "@/lib/region/apply";

export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requirePermission("mappings.manage");
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
    await requirePermission("mappings.manage");
    const { kind } = await context.params;
    const body = await request.json();
    const store = await getStore();
    if (kind === "channel") await store.saveChannelMap(body);
    else if (kind === "province") {
      const raw = String(body.raw ?? "").trim();
      if (!raw) throw new AppError("Isi provinsi mentah.");
      if (!String(body.official ?? "").trim()) throw new AppError("Isi provinsi resmi.");
      await store.saveProvinceMap({ ...body, raw });
      await closeProvinceReviews(store, raw);
    } else if (kind === "city") {
      const provinceRaw = String(body.provinceRaw ?? "").trim();
      const cityRaw = String(body.cityRaw ?? "").trim();
      if (!provinceRaw || !cityRaw) throw new AppError("Isi provinsi dan kota mentah.");
      if (!String(body.official ?? "").trim()) throw new AppError("Isi kab/kota resmi.");
      await store.saveCityMap({ ...body, provinceRaw, cityRaw });
      await closeCityReviews(store, provinceRaw, cityRaw);
    } else throw new AppError("Mapping tidak dikenal.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requirePermission("mappings.manage");
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
