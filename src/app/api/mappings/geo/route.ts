import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/access/store";
import { getStore } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";
import { buildGeoPairs, countPendingGeo } from "@/lib/region/pairs";
import { commitGeoRows, geoAuditEntry, isGeoBulkBody } from "@/lib/region/save-geo";

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
    const body = await request.json();
    const store = await getStore();
    const audit = async (row: Parameters<typeof geoAuditEntry>[1]) => {
      await recordAudit(geoAuditEntry(session.email, row));
    };
    if (isGeoBulkBody(body)) {
      if (!body.items.length) throw new AppError("Pilih minimal satu baris.");
      const outcome = await commitGeoRows(store, body.items, audit);
      return NextResponse.json(outcome);
    }
    const outcome = await commitGeoRows(store, [body], audit);
    if (!outcome.saved) throw new AppError(outcome.failed[0]?.error || "Gagal menyimpan mapping.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
