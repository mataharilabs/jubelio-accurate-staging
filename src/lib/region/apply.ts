import type { ReviewItem } from "@/lib/db/types";
import { sameProvinceScope, sameRegion, type ProvinceSource } from "@/lib/region/names";

type ReviewStore = {
  listReviews(): Promise<ReviewItem[]>;
  resolveReview(id: string): Promise<void>;
};

export async function closeProvinceReviews(store: ReviewStore, raw: string) {
  const reviews = await store.listReviews();
  for (const review of reviews) {
    if (review.status !== "open" || review.kind !== "province") continue;
    const value = review.detail.province || review.rawKey;
    if (sameRegion(value, raw)) await store.resolveReview(review.id);
  }
}

export async function closeCityReviews(store: ReviewStore, provinceRaw: string, cityRaw: string, provinces: ProvinceSource[] = []) {
  const reviews = await store.listReviews();
  for (const review of reviews) {
    if (review.status !== "open" || review.kind !== "city") continue;
    if (!sameRegion(review.detail.city ?? "", cityRaw)) continue;
    const reviewProvince = review.detail.province || review.detail.provinceOfficial || "";
    if (sameProvinceScope(reviewProvince, provinceRaw, provinces) || sameProvinceScope(review.detail.provinceOfficial ?? "", provinceRaw, provinces)) {
      await store.resolveReview(review.id);
    }
  }
}
