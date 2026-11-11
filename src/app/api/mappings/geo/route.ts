import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";
import { closeCityReviews, closeProvinceReviews } from "@/lib/region/apply";
import { buildGeoPairs, countPendingGeo } from "@/lib/region/pairs";

export async function GET() {
  try {
    await requirePermission("mappings.manage");
    const store = await getStore();
    const [provinces, cities, reviews] = await Promise.all([
      store.listProvinceMaps(),
      store.listCityMaps(),
      store.listReviews(),
    ]);
    const rows = buildGeoPairs({ provinces, cities, reviews });
    return NextResponse.json({ rows, pending: countPendingGeo(rows) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePermission("mappings.manage");
    const body = await request.json() as { provinceRaw?: string; cityRaw?: string; provinceOfficial?: string; cityOfficial?: string };
    const provinceRaw = String(body.provinceRaw ?? "").trim();
    const cityRaw = String(body.cityRaw ?? "").trim();
    const provinceOfficial = String(body.provinceOfficial ?? "").trim();
    const cityOfficial = String(body.cityOfficial ?? "").trim();
    if (!provinceRaw) throw new AppError("Isi provinsi dari Jubelio.");
    if (!provinceOfficial) throw new AppError("Isi provinsi standar.");
    if (cityRaw && !cityOfficial) throw new AppError("Isi kota standar.");
    if (!cityRaw && cityOfficial) throw new AppError("Isi kota dari Jubelio.");
    const store = await getStore();
    await store.saveProvinceMap({ raw: provinceRaw, official: provinceOfficial, needsReview: false });
    await closeProvinceReviews(store, provinceRaw);
    if (cityRaw) {
      await store.saveCityMap({ provinceRaw, cityRaw, official: cityOfficial, needsReview: false });
      await closeCityReviews(store, provinceRaw, cityRaw, await store.listProvinceMaps());
    }
    await recordAudit({
      actorEmail: session.email,
      action: "mapping.geo",
      entity: "geo",
      entityId: `${provinceRaw} | ${cityRaw}`,
      before: null,
      after: { provinceRaw, cityRaw, provinceOfficial, cityOfficial },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
