import { describe, expect, it } from "vitest";
import { authLinkError, parseAuthLink, requestOrigin, setPasswordPath } from "@/lib/auth/links";

describe("invite and recovery links", () => {
  it("reads a PKCE code", () => {
    expect(parseAuthLink("?code=abc", "")).toEqual({ kind: "code", code: "abc" });
    expect(setPasswordPath("?code=abc")).toBe("/atur-sandi?code=abc");
  });

  it("reads a token_hash invite or recovery", () => {
    expect(parseAuthLink("?token_hash=th&type=invite")).toEqual({ kind: "otp", tokenHash: "th", type: "invite" });
    expect(parseAuthLink("?token_hash=th&type=recovery")).toEqual({ kind: "otp", tokenHash: "th", type: "recovery" });
  });

  it("reads hash-fragment tokens and keeps them on the set-password path", () => {
    const hash = "#access_token=at&refresh_token=rt&type=invite";
    expect(parseAuthLink("", hash)).toEqual({ kind: "session", accessToken: "at", refreshToken: "rt" });
    expect(setPasswordPath("", hash)).toBe(`/atur-sandi${hash}`);
  });

  it("ignores a normal login URL", () => {
    expect(parseAuthLink("", "")).toBeNull();
    expect(setPasswordPath("")).toBeNull();
  });

  it("explains an expired link", () => {
    expect(authLinkError("?error_code=otp_expired&type=invite")).toMatch(/kedaluwarsa/);
    expect(setPasswordPath("?error=access_denied&error_code=otp_expired")).toBe("/atur-sandi?error=access_denied&error_code=otp_expired");
  });

  it("builds the redirect origin from the request, then the app URL", () => {
    const forwarded = new Request("http://internal/masuk", {
      headers: { "x-forwarded-host": "ecommerce.asiacommerce.net", "x-forwarded-proto": "https" },
    });
    expect(requestOrigin(forwarded)).toBe("https://ecommerce.asiacommerce.net");
    const local = new Request("http://127.0.0.1:3847/masuk");
    expect(requestOrigin(local)).toBe("http://127.0.0.1:3847");
  });
});
