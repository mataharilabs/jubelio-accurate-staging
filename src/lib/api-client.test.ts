import { describe, expect, it } from "vitest";
import { invalidJsonMessage, readApiBody } from "@/lib/api-client";

describe("api client bodies", () => {
  it("names a timeout when the body is not JSON", () => {
    expect(invalidJsonMessage(504)).toBe("Server timeout (HTTP 504), coba lagi");
    expect(() => readApiBody(504, "<html>gateway timeout</html>")).toThrow("Server timeout (HTTP 504), coba lagi");
    expect(() => readApiBody(502, "bad gateway")).toThrow("Respons server tidak valid (HTTP 502).");
  });

  it("treats HTTP 200 with a non-JSON body as an error", () => {
    expect(() => readApiBody(200, "ok")).toThrow("Respons server tidak valid (HTTP 200).");
    expect(readApiBody(200, "{\"rows\":[]}")).toEqual({ rows: [] });
    expect(readApiBody(200, "")).toEqual({});
  });

  it("keeps a JSON error message from a failed response", () => {
    expect(() => readApiBody(400, "{\"error\":\"Pilih pesanan.\"}")).toThrow("Pilih pesanan.");
    expect(() => readApiBody(500, "")).toThrow("Permintaan gagal (HTTP 500).");
  });
});