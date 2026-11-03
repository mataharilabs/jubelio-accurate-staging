import { describe, expect, it } from "vitest";
import { itemNameFromPayload } from "@/lib/jubelio/item-name";

describe("Jubelio item name", () => {
  it("reads only the name field and ignores the rest of the payload", () => {
    expect(itemNameFromPayload({ data: [{ item_code: "SKU", item_name: "  Sabun  ", secret: "nope" }] })).toBe("Sabun");
    expect(itemNameFromPayload({ name: "Cadangan" })).toBe("Cadangan");
    expect(itemNameFromPayload({})).toBeNull();
  });
});
