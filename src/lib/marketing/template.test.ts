import { describe, expect, it } from "vitest";
import { exportCsv } from "@/lib/marketing/template";

describe("marketing csv export", () => {
  it("neutralizes a formula that starts after a leading line break and quotes carriage returns", () => {
    expect(exportCsv([{ Kampanye: "=1+1" }])).toBe("Kampanye\n'=1+1");
    expect(exportCsv([{ Kampanye: "\r=1+1" }])).toBe("Kampanye\n\"'\r=1+1\"");
    expect(exportCsv([{ Kampanye: "\n+cmd" }])).toBe("Kampanye\n\"'\n+cmd\"");
    expect(exportCsv([{ Kampanye: "hello\rworld" }])).toBe("Kampanye\n\"hello\rworld\"");
    expect(exportCsv([{ Spend: 2500 }])).toBe("Spend\n2500");
  });
});
