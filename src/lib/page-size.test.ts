import { describe, expect, it } from "vitest";
import { clampPageSize, PAGE_SIZE_OPTIONS } from "@/lib/page-size";

describe("clampPageSize", () => {
  it("keeps the allowed sizes", () => {
    for (const size of PAGE_SIZE_OPTIONS) expect(clampPageSize(size)).toBe(size);
    expect(clampPageSize("100")).toBe(100);
  });

  it("falls back when the value is not a page size", () => {
    expect(clampPageSize("30")).toBe(25);
    expect(clampPageSize(null, 10)).toBe(10);
    expect(clampPageSize("")).toBe(25);
  });
});
