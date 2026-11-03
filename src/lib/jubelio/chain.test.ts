import { afterEach, describe, expect, it } from "vitest";
import { continuationHeaders, continuationUrl, continueCron, enqueueContinuation } from "@/lib/jubelio/chain";
import { canClaim } from "@/lib/jubelio/schedule";

describe("jubelio cron continuation", () => {
  const previous = { vercel: process.env.VERCEL_URL, bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET };
  afterEach(() => {
    if (previous.vercel == null) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = previous.vercel;
    if (previous.bypass == null) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = previous.bypass;
  });

  it("calls the deployment that is running, not only the public request url", () => {
    process.env.VERCEL_URL = "jubelio-accurate-staging-abc.vercel.app";
    expect(continuationUrl("https://ecommerce.asiacommerce.id/api/cron/jubelio?schedule=daily")).toBe(
      "https://jubelio-accurate-staging-abc.vercel.app/api/cron/jubelio?schedule=daily",
    );
  });

  it("schedules a promise so the next step is not deferred until the request closes", async () => {
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const seen: Promise<unknown>[] = [];
    let called = "";
    continueCron(
      "https://ecommerce.asiacommerce.id/api/cron/jubelio?schedule=daily",
      "Bearer cron-secret",
      0,
      true,
      false,
      (task) => {
        expect(task).toBeInstanceOf(Promise);
        seen.push(task);
      },
      async (url, init) => {
        called = String(url);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cron-secret");
        expect(new Headers(init?.headers).get("x-job-chain")).toBe("1");
        return new Response("{}", { status: 202 });
      },
    );
    await seen[0];
    expect(called).toContain("/api/cron/jubelio?schedule=daily");
  });

  it("sends a protection bypass when one is configured and does not put it in the error text", async () => {
    delete process.env.VERCEL_URL;
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
    const headers = continuationHeaders("Bearer cron-secret", 2, process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
    expect(headers["x-vercel-protection-bypass"]).toBe("bypass-secret");
    expect(headers.authorization).toBe("Bearer cron-secret");
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      await enqueueContinuation(async (task) => { await task; }, Promise.resolve());
    } finally {
      console.error = original;
    }
    expect(JSON.stringify(logged)).not.toContain("bypass-secret");
  });

  it("lets the next step claim a running job whose lease was already released", () => {
    const now = Date.parse("2026-11-03T10:03:00.000Z");
    expect(canClaim({ status: "running", leaseToken: null, leaseUntil: null }, "next", now)).toBe("claim");
    expect(canClaim({ status: "running", leaseToken: "old", leaseUntil: "2026-11-03T09:34:00.000Z" }, "next", now)).toBe("claim");
  });
});
