import { describe, expect, it } from "vitest";
import { isMarketplaceChannel } from "@/lib/fees/channel";

describe("marketplace channels", () => {
  it("keeps marketplace names and drops website, staff, offline, and POS", () => {
    for (const name of ["Shopee", "Lazada", "Tiktok", "Tokopedia", "BliBli", "Bukalapak"]) {
      expect(isMarketplaceChannel(name)).toBe(true);
    }
    for (const name of ["Website", "WEBSTORE", "Web Store", "Offline Market", "Jubelio POS", "Internal", "Staff Sales", "Kasir", "Manual", ""]) {
      expect(isMarketplaceChannel(name)).toBe(false);
    }
  });
});
