import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { isBundlePending, isMappingPending } from "@/lib/domain/phase3";
import { fail, requireSession } from "@/lib/http";
import { listProducts } from "@/lib/products/service";

export async function GET() {
  try {
    await requireSession();
    const store = await getStore();
    const [channels, provinces, cities, weights, reviews] = await Promise.all([
      store.listChannelMaps(),
      store.listProvinceMaps(),
      store.listCityMaps(),
      store.listWeights(),
      store.listReviews(),
    ]);
    let hpp = 0;
    try {
      const products = await listProducts();
      hpp = products.filter((row) => row.active !== false && row.hpp == null).length;
    } catch {
      hpp = 0;
    }
    return NextResponse.json({
      channel: channels.filter((row) => isMappingPending(row)).length,
      geo: provinces.filter((row) => isMappingPending(row)).length + cities.filter((row) => isMappingPending(row)).length,
      bundle: reviews.filter((row) => row.kind === "bobot" && row.status === "open").length + weights.filter((row) => isBundlePending(row)).length,
      hpp,
    });
  } catch (error) {
    return fail(error);
  }
}
