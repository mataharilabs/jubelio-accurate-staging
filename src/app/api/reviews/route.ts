import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";
import { closeCityReviews, closeProvinceReviews } from "@/lib/region/apply";

type Resolution = { id?: string; official?: string };

export async function GET() {
  try {
    await requirePermission("mappings.manage");
    return NextResponse.json(await (await getStore()).listReviews());
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    await requirePermission("mappings.manage");
    const body = (await request.json()) as Resolution & { items?: Resolution[] };
    const items = body.items?.length ? body.items : [{ id: body.id, official: body.official }];
    const store = await getStore();
    const reviews = await store.listReviews();
    for (const item of items) {
      const review = reviews.find((row) => row.id === item.id);
      if (!review || review.status !== "open") continue;
      const official = item.official?.trim() ?? "";
      if (review.kind === "province") {
        if (!official) throw new AppError("Isi provinsi resmi sebelum menutup review.");
        const raw = review.detail.province || review.rawKey;
        await store.saveProvinceMap({ raw, official, needsReview: false });
        await closeProvinceReviews(store, raw);
      } else if (review.kind === "city") {
        if (!official) throw new AppError("Isi kab/kota resmi sebelum menutup review.");
        const provinceRaw = review.detail.province ?? "";
        const cityRaw = review.detail.city || review.rawKey;
        await store.saveCityMap({ provinceRaw, cityRaw, official, needsReview: false });
        await closeCityReviews(store, provinceRaw, cityRaw);
      } else if (item.id) {
        await store.resolveReview(item.id);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
