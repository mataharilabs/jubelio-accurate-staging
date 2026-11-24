import { describe, expect, it } from "vitest";
import { alignTrend, previousEqualWindow } from "@/lib/domain/phase3";

describe("trend comparison alignment", () => {
  it("pairs days by the previous equal window and leaves a marketing-only day unmatched", () => {
    const currentFrom = "2026-11-01";
    const currentTo = "2026-11-10";
    const previous = previousEqualWindow(currentFrom, currentTo);
    const current = [
      { bucket: "2026-11-01", net: 10 },
      { bucket: "2026-11-09", net: 0 },
      { bucket: "2026-11-10", net: 30 },
    ];
    const prior = [
      { bucket: previous.from, net: 1 },
      { bucket: previous.to, net: 3 },
    ];
    const aligned = alignTrend(current, prior, currentFrom, previous.from);
    expect(aligned.map((row) => row?.net)).toEqual([1, undefined, 3]);
    expect(aligned[1]).toBeUndefined();
  });

  it("keeps index pairing when both windows have the same relative days", () => {
    const currentFrom = "2026-11-01";
    const currentTo = "2026-11-02";
    const previous = previousEqualWindow(currentFrom, currentTo);
    const current = [
      { bucket: "2026-11-01", net: 10 },
      { bucket: "2026-11-02", net: 20 },
    ];
    const prior = [
      { bucket: previous.from, net: 1 },
      { bucket: previous.to, net: 2 },
    ];
    expect(alignTrend(current, prior, currentFrom, previous.from).map((row) => row?.net)).toEqual([1, 2]);
  });
});
