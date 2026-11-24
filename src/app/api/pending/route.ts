import { NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { isBundlePending, isMappingPending } from "@/lib/domain/phase3";
import { buildGeoPairs, countPendingGeo } from "@/lib/region/pairs";
import { fail, requireSession } from "@/lib/http";
import { listProducts } from "@/lib/products/service";

export const maxDuration = 60;

const QUEUE_COUNT_MS = 60_000;
let queueCountCache: { at: number; orders: number } | null = null;

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
    let orders = 0;
    try {
      const now = Date.now();
      if (queueCountCache && now - queueCountCache.at < QUEUE_COUNT_MS) {
        orders = queueCountCache.orders;
      } else {
        orders = await store.countSyncQueue();
        queueCountCache = { at: now, orders };
      }
    } catch {
      orders = 0;
    }
    return NextResponse.json({
      channel: channels.filter((row) => isMappingPending(row)).length,
      geo: countPendingGeo(buildGeoPairs({ provinces, cities, reviews })),
      bundle: reviews.filter((row) => row.kind === "bobot" && row.status === "open").length + weights.filter((row) => isBundlePending(row)).length,
      hpp,
      orders,
    });
  } catch (error) {
    return fail(error);
  }
}
