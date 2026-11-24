import { describe, expect, it } from "vitest";
import { barBox, chartExtent } from "@/components/charts";

describe("bar chart scale", () => {
  it("draws a negative value below the zero baseline instead of clamping it away", () => {
    const extent = chartExtent([100, -40]);
    expect(extent.min).toBeLessThan(0);
    expect(extent.max).toBeGreaterThan(100);
    const positive = barBox(100, extent.min, extent.max, 14, 200);
    const negative = barBox(-40, extent.min, extent.max, 14, 200);
    const zero = barBox(0, extent.min, extent.max, 14, 200);
    expect(negative.height).toBeGreaterThan(0);
    expect(negative.y).toBeGreaterThan(positive.y);
    expect(negative.y).toBeCloseTo(positive.y + positive.height, 5);
    expect(zero.height).toBe(0);
  });

  it("keeps a positive-only series based at zero", () => {
    const extent = chartExtent([100, 50]);
    expect(extent.min).toBe(0);
    expect(extent.max).toBeCloseTo(108, 5);
  });

  it("includes a line series in the same extent as the bars", () => {
    const barsOnly = chartExtent([100]);
    const withLine = chartExtent([100, 200]);
    expect(withLine.max).toBeGreaterThan(barsOnly.max);
    expect(withLine.max).toBeGreaterThan(200);
    expect(chartExtent([100, -20]).min).toBeLessThan(0);
  });
});
