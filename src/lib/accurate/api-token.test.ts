import { describe, expect, it, vi } from "vitest";
import { accurateReadHeaders, fetchNearestCost, openAccurateHost, readNearestCost, signAccurateTimestamp } from "@/lib/accurate/api-token";

describe("Accurate API token", () => {
  it("signs the timestamp and does not put the secret in the signature input headers beyond the hmac", () => {
    const signature = signAccurateTimestamp("2026-11-03T10:00:00.000Z", "secret-key");
    expect(signature).toBe(signAccurateTimestamp("2026-11-03T10:00:00.000Z", "secret-key"));
    expect(signature).not.toContain("secret-key");
    const headers = accurateReadHeaders("token-value", "secret-key", "2026-11-03T10:00:00.000Z");
    expect(headers.Authorization).toBe("Bearer token-value");
    expect(headers["X-Api-Timestamp"]).toBe("2026-11-03T10:00:00.000Z");
    expect(headers["X-Api-Signature"]).toBe(signature);
  });

  it("reads a successful cost, a logical failure, and a 308 redirect", async () => {
    expect(readNearestCost({ s: true, d: { unitCost: 12500, id: 9 } })).toEqual({ found: true, unitCost: 12500, itemId: "9", message: null });
    expect(readNearestCost({ s: false, d: "Item tidak ditemukan" }).found).toBe(false);

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("api-token.do")) {
        return new Response(null, { status: 308, headers: { location: "https://zeus.accurate.id/api/open-db.do" } });
      }
      if (String(url).includes("open-db.do")) {
        return Response.json({ s: true, d: { database: { host: "https://zeus.accurate.id" } } });
      }
      expect(init?.method).toBe("GET");
      return Response.json({ s: true, d: { cost: 4000, id: 3 } });
    });
    const host = await openAccurateHost(fetchImpl, "token", "secret", new Date("2026-11-03T10:00:00.000Z"));
    expect(host).toBe("https://zeus.accurate.id");
    const cost = await fetchNearestCost(fetchImpl, host, "token", "secret", "SKU-1", "01/11/2026", new Date("2026-11-03T10:00:00.000Z"));
    expect(cost).toMatchObject({ found: true, unitCost: 4000, itemId: "3" });
    expect(String(fetchImpl.mock.calls.find((call) => String(call[0]).includes("get-nearest-cost"))?.[0])).toContain("transDate=01%2F11%2F2026");
  });

  it("falls back to item detail when nearest cost has no number", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("get-nearest-cost")) return Response.json({ s: true, d: { id: 4 } });
      return Response.json({ s: true, d: { hpp: 777, id: 4 } });
    });
    const cost = await fetchNearestCost(fetchImpl, "https://zeus.accurate.id", "token", "secret", "SKU-2", "01/10/2026", new Date("2026-11-03T10:00:00.000Z"));
    expect(cost.unitCost).toBe(777);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("item/detail.do");
  });
});
