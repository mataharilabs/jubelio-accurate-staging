import { readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { formatPeriod, monthBoundaryMessage, sameCalendarMonth } from "@/lib/marketing/dates";
import { formatPct, metricsOf, sumMetrics } from "@/lib/marketing/metrics";
import { duplicateGroups } from "@/lib/marketing/overlap";
import { parseNumber, parseUpload } from "@/lib/marketing/parse";
import { matchStore } from "@/lib/marketing/stores";
import { templateWorkbook } from "@/lib/marketing/template";

const dir = path.join(process.cwd(), "samples/marketing");

function file(name: string): Buffer {
  return readFileSync(path.join(dir, name));
}

function totals(name: string, platform: string) {
  const parsed = parseUpload(name, file(name), platform);
  const summed = sumMetrics(parsed.rows);
  return { parsed, summed };
}

describe("marketing parsers", () => {
  it("reads the Shopee Ads sample", () => {
    const { parsed, summed } = totals("shopee-ads.csv", "Shopee Ads");
    expect(parsed.crossesMonth).toBe(false);
    expect(parsed.storeRaw).toBe("Jansen Official Shop");
    expect(parsed.periodStart).toBe("2026-11-09");
    expect(parsed.periodEnd).toBe("2026-11-15");
    expect(parsed.rows).toHaveLength(12);
    expect(parsed.skipped).toHaveLength(0);
    expect(summed.spend).toBe(3_771_000);
    expect(summed.impressions).toBe(94_939);
    expect(summed.clicks).toBe(3_068);
    expect(summed.orders).toBe(334);
    expect(summed.adsRevenue).toBe(57_224_600);
    expect(parsed.rows[0]?.campaign.startsWith("Nutrimax Vitamin D3 1000")).toBe(true);
    expect(parsed.rows[0]?.spend).toBe(501_900);
  });

  it("reads TikTok GMV Max by day and skips the total row", () => {
    const { parsed, summed } = totals("tiktok-gmv-max.xlsx", "TikTok Ads");
    expect(parsed.splitDaily).toBe(true);
    expect(parsed.crossesMonth).toBe(false);
    expect(parsed.rows).toHaveLength(7);
    expect(parsed.skipped.map((row) => row.reason)).toEqual(["baris total"]);
    expect(parsed.rows.every((row) => row.campaign === "GMV Max")).toBe(true);
    expect(parsed.rows.every((row) => row.impressions == null && row.clicks == null)).toBe(true);
    expect(parsed.rows.map((row) => row.periodStart)).toEqual([
      "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
    ]);
    expect(summed.spend).toBe(2_327_747);
    expect(summed.orders).toBe(189);
    // TikTok's total row says 18.547.914, one rupiah above the seven daily rows. The days are stored as reported.
    expect(summed.adsRevenue).toBe(18_547_913);
  });

  it("reads Meta Ads and skips the blank campaign total", () => {
    const { parsed, summed } = totals("meta-ads.xlsx", "Meta Ads");
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.readCount).toBe(5);
    expect(parsed.skipped.map((row) => row.reason)).toEqual(["baris total tanpa nama kampanye"]);
    expect(summed.spend).toBe(577_441);
    expect(summed.impressions).toBe(107_647);
    expect(summed.clicks).toBe(5_081);
    expect(summed.orders).toBeNull();
    expect(summed.adsRevenue).toBeNull();
    expect(parsed.rows[0]?.campaign).toBe("Flauhra Floral");
    expect(parsed.periodStart).toBe("2026-11-09");
    expect(parsed.periodEnd).toBe("2026-11-15");
  });

  it("reads CPAS orders and revenue", () => {
    const { parsed, summed } = totals("cpas.xlsx", "CPAS");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.skipped).toHaveLength(1);
    expect(summed.spend).toBe(170_610);
    expect(summed.orders).toBe(5);
    expect(summed.adsRevenue).toBe(462_000);
    expect(parsed.rows.every((row) => row.periodStart === "2026-11-09" && row.periodEnd === "2026-11-15")).toBe(true);
  });

  it("sums the four sample files to the November grand total", () => {
    const files = [
      ["shopee-ads.csv", "Shopee Ads"],
      ["tiktok-gmv-max.xlsx", "TikTok Ads"],
      ["meta-ads.xlsx", "Meta Ads"],
      ["cpas.xlsx", "CPAS"],
    ] as const;
    const spend = files.reduce((total, [name, platform]) => total + totals(name, platform).summed.spend, 0);
    const rows = files.reduce((total, [name, platform]) => total + totals(name, platform).parsed.rows.length, 0);
    expect(spend).toBe(6_846_798);
    expect(rows).toBe(25);
  });

  it("rejects an aggregate report that crosses a month", () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Campaign name", "Amount spent (IDR)", "Impressions", "Link clicks", "Reporting starts", "Reporting ends"],
      ["", 100, 10, 1, "2026-10-28", "2026-11-03"],
      ["Lintas bulan", 100, 10, 1, "2026-10-28", "2026-11-03"],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, "Raw Data Report");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const parsed = parseUpload("Meta Ads Report 28 Okt-3 Nov 2026.xlsx", buffer, "Meta Ads");
    expect(parsed.crossesMonth).toBe(true);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.monthMessage).toContain("Oktober–November");
    expect(parsed.monthMessage).toContain("Tombol simpan dinonaktifkan");
    expect(sameCalendarMonth("2026-10-28", "2026-11-03")).toBe(false);
    expect(monthBoundaryMessage("laporan.xlsx", "Meta Ads", "Bee & Flower", "2026-10-28", "2026-11-03")).toMatch(/28 Okt 2026/);
  });

  it("keeps TikTok days that fall in two months", () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["By Day", "Cost", "SKU orders (Current shop)", "Gross revenue (Current shop)"],
      ["2026-10-31", 10, 1, 20],
      ["2026-11-01", 15, 2, 30],
      ["-", 25, 3, 50],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const parsed = parseUpload("tiktok.xlsx", buffer, "TikTok Ads");
    expect(parsed.crossesMonth).toBe(false);
    expect(parsed.rows.map((row) => row.periodStart)).toEqual(["2026-10-31", "2026-11-01"]);
    expect(parsed.note).toMatch(/dipisah per tanggal/);
  });

  it("round-trips the standard template and rejects a row that crosses months", () => {
    const buffer = templateWorkbook();
    const parsed = parseUpload("template.xlsx", buffer, "Template Excel");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      platform: "Lazada Ads",
      storeRaw: "Nama Toko",
      campaign: "Nama kampanye",
      spend: 250000,
      periodStart: "2026-11-09",
      periodEnd: "2026-11-15",
    });
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["tanggal_mulai", "tanggal_selesai", "platform", "toko", "nama_kampanye", "spend"],
      ["28/10/2026", "03/11/2026", "Lazada Ads", "Bee & Flower", "Akhir bulan", 1000],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, "Marketing");
    const bad = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const rejected = parseUpload("template.xlsx", bad, "Lazada Ads");
    expect(rejected.crossesMonth).toBe(true);
    expect(rejected.rows).toHaveLength(0);
  });

  it("rejects an unknown template platform instead of using the selected platform", () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["tanggal_mulai", "tanggal_selesai", "platform", "toko", "nama_kampanye", "spend"],
      ["09/11/2026", "15/11/2026", "TikTok", "Bee & Flower", "Salah", 1000],
      ["09/11/2026", "15/11/2026", "", "Bee & Flower", "Kosong", 500],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, "Marketing");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const parsed = parseUpload("template.xlsx", buffer, "Lazada Ads");
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.monthMessage).toMatch(/Platform tidak dikenal: TikTok/);
    expect(parsed.monthMessage).not.toMatch(/Lazada Ads mengikuti/);
  });

  it("rejects an unknown platform even when the date is also invalid", () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["tanggal_mulai", "tanggal_selesai", "platform", "toko", "nama_kampanye", "spend"],
      ["bukan-tanggal", "juga-bukan", "Nope", "Bee & Flower", "Rusak", 1000],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, "Marketing");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const parsed = parseUpload("template.xlsx", buffer, "Lazada Ads");
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.monthMessage).toMatch(/Platform tidak dikenal: Nope/);
    expect(parsed.skipped.map((row) => row.reason).join(" ")).not.toMatch(/tanggal tidak terbaca/);
  });
});

describe("marketing metrics", () => {
  it("computes ratios from summed values and shows a blank when the denominator is missing", () => {
    const shopee = metricsOf({ spend: 501_900, impressions: 24_998, clicks: 787, orders: 69, adsRevenue: 8_540_300 });
    expect(formatPct(shopee.ctr)).toBe("3,15%");
    expect(Math.round(shopee.cpc ?? 0)).toBe(638);
    expect(Math.round(shopee.cpm ?? 0)).toBe(20_078);
    expect(formatPct(shopee.cvr)).toBe("8,77%");
    expect(Math.round(shopee.cpo ?? 0)).toBe(7_274);
    expect(shopee.roas?.toFixed(2)).toBe("17.02");
    expect(formatPct(shopee.acos)).toBe("5,88%");

    const missing = metricsOf({ spend: 100, impressions: null, clicks: null, orders: null, adsRevenue: null });
    expect(missing.ctr).toBeNull();
    expect(missing.cpc).toBeNull();
    expect(missing.roas).toBeNull();
    expect(metricsOf({ spend: 100, impressions: 0, clicks: 0, orders: 0, adsRevenue: 0 }).cpm).toBeNull();

    const summed = metricsOf(sumMetrics([
      { spend: 100, impressions: 10, clicks: 10, orders: 1, adsRevenue: 50 },
      { spend: 100, impressions: 10, clicks: 1, orders: 1, adsRevenue: 50 },
    ]));
    expect(summed.cpc).toBeCloseTo(200 / 11, 6);
    expect(summed.cpc).not.toBeCloseTo((10 + 100) / 2, 1);
  });

  it("maps a Shopee shop name onto the app store and finds overlapping uploads", () => {
    expect(matchStore("Jansen Official Shop", ["Jansen Official Store", "Bee & Flower"]).match).toBe("Jansen Official Store");
    expect(matchStore("Toko baru", ["Jansen Official Store"]).match).toBeNull();
    expect(parseNumber("Rp501.900")).toBe(501900);
    expect(formatPeriod("2026-11-09", "2026-11-15")).toBe("9–15 Nov 26");
    const groups = duplicateGroups(
      [{ id: "a", platform: "Shopee Ads", storeName: "Jansen Official Store", periodStart: "2026-11-09", periodEnd: "2026-11-15" }],
      [{ platform: "Shopee Ads", storeName: "jansen official store", periodStart: "2026-11-12", periodEnd: "2026-11-18" }],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(1);
    expect(groups[0]?.ids).toEqual(["a"]);
  });
});
