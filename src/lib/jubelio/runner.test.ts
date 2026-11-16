import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataStore } from "@/lib/db/store";
import { JubelioClient } from "@/lib/jubelio/client";
import { createJob, saveJob } from "@/lib/jubelio/jobs";
import { advancePull } from "@/lib/jubelio/runner";
import { deactivateSupersededProducts, ensureProducts } from "@/lib/products/service";

vi.mock("@/lib/db", () => ({
  getStore: vi.fn(),
}));

vi.mock("@/lib/products/service", () => ({
  ensureProducts: vi.fn(async () => []),
  deactivateSupersededProducts: vi.fn(async () => []),
}));

import { getStore } from "@/lib/db";

const detailOrder = {
  salesorder_id: 99,
  salesorder_no: "SO-99",
  transaction_date: "2026-10-27T17:30:00.000Z",
  ref_no: "587017731545663293",
  source_name: "TIKTOK",
  store_name: "Toko",
  shipping_full_name: "Pembeli",
  customer_name: "Pembeli",
  shipping_city: "JAKARTA",
  shipping_province: "DKI JAKARTA",
  courier: "JNE",
  internal_status: "COMPLETED",
  location_name: "Lintas Sby",
  items: [{
    item_id: 1,
    is_bundle: false,
    item_code: "50001897",
    description: "Produk asli",
    qty: 1,
    price: 10000,
    amount: 10000,
    loc_name: "Lintas Sby",
  }],
};

async function detailJob() {
  const job = await createJob("manual", "tester", ["2026-10-28"], "running");
  job.days = [];
  job.day = "2026-10-28";
  job.listDone = true;
  job.pendingIds = [detailOrder.salesorder_id];
  await saveJob(job);
  return job;
}

describe("detailChunk product cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(JubelioClient.prototype, "configured").mockReturnValue(true);
    vi.spyOn(JubelioClient.prototype, "get").mockImplementation(async (path: string) => {
      if (path.startsWith("/sales/orders/")) return detailOrder;
      throw new Error(`unexpected Jubelio path ${path}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the superseded-SKU cleanup after ensureProducts when a new version was imported", async () => {
    const importRawLines = vi.fn(async () => ({ newVersions: 1, reviews: 0 }));
    vi.mocked(getStore).mockResolvedValue({
      getSettings: async () => ({ jubelioLocations: ["Lintas Sby"] }),
      importRawLines,
      listWeights: async () => [],
      listBundleComponents: async () => [],
      listChannelMaps: async () => [],
      listProvinceMaps: async () => [],
      listCityMaps: async () => [],
    } as unknown as DataStore);
    const job = await detailJob();
    await advancePull(job.id, 40_000);
    expect(importRawLines).toHaveBeenCalled();
    expect(ensureProducts).toHaveBeenCalled();
    expect(deactivateSupersededProducts).toHaveBeenCalledTimes(1);
    const importedAt = importRawLines.mock.invocationCallOrder[0];
    const ensuredAt = vi.mocked(ensureProducts).mock.invocationCallOrder[0];
    const cleanedAt = vi.mocked(deactivateSupersededProducts).mock.invocationCallOrder[0];
    expect(importedAt).toBeLessThan(ensuredAt);
    expect(ensuredAt).toBeLessThan(cleanedAt);
  });

  it("does not clean up when the import saved no new version", async () => {
    const importRawLines = vi.fn(async () => ({ newVersions: 0, reviews: 0 }));
    vi.mocked(getStore).mockResolvedValue({
      getSettings: async () => ({ jubelioLocations: ["Lintas Sby"] }),
      importRawLines,
      listWeights: async () => [],
      listBundleComponents: async () => [],
      listChannelMaps: async () => [],
      listProvinceMaps: async () => [],
      listCityMaps: async () => [],
    } as unknown as DataStore);
    const job = await detailJob();
    await advancePull(job.id, 40_000);
    expect(ensureProducts).toHaveBeenCalled();
    expect(deactivateSupersededProducts).not.toHaveBeenCalled();
  });
});
