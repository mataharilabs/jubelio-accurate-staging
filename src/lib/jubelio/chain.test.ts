import { afterEach, describe, expect, it } from "vitest";
import { continuationHeaders, continuationUrl, continueCron, isProductionHost, postContinuation } from "@/lib/jubelio/chain";
import { canClaim } from "@/lib/jubelio/schedule";

describe("jubelio cron continuation", () => {
  const previous = {
    vercel: process.env.VERCEL_URL,
    branch: process.env.VERCEL_BRANCH_URL,
    production: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    app: process.env.NEXT_PUBLIC_APP_URL,
    bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  };
  afterEach(() => {
    restore("VERCEL_URL", previous.vercel);
    restore("VERCEL_BRANCH_URL", previous.branch);
    restore("VERCEL_PROJECT_PRODUCTION_URL", previous.production);
    restore("NEXT_PUBLIC_APP_URL", previous.app);
    restore("VERCEL_AUTOMATION_BYPASS_SECRET", previous.bypass);
  });

  it("keeps a production origin and refuses the SSO-protected deployment host", () => {
    process.env.VERCEL_URL = "jubelio-accurate-staging-h5v1jd4q8.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "jubelio-accurate-staging.vercel.app";
    process.env.NEXT_PUBLIC_APP_URL = "https://ecommerce.asiacommerce.id";
    expect(isProductionHost("ecommerce.asiacommerce.id")).toBe(true);
    expect(isProductionHost("jubelio-accurate-staging.vercel.app")).toBe(true);
    expect(isProductionHost("jubelio-accurate-staging-h5v1jd4q8.vercel.app")).toBe(false);
    expect(continuationUrl("https://ecommerce.asiacommerce.id/api/cron/jubelio?schedule=daily")).toBe(
      "https://ecommerce.asiacommerce.id/api/cron/jubelio?schedule=daily",
    );
    expect(continuationUrl("https://jubelio-accurate-staging.vercel.app/api/cron/jubelio?schedule=daily")).toBe(
      "https://jubelio-accurate-staging.vercel.app/api/cron/jubelio?schedule=daily",
    );
    expect(continuationUrl("https://jubelio-accurate-staging-h5v1jd4q8.vercel.app/api/cron/jubelio?schedule=daily")).toBe(
      "https://jubelio-accurate-staging.vercel.app/api/cron/jubelio?schedule=daily",
    );
  });

  it("falls back to NEXT_PUBLIC_APP_URL when the request host is the deployment URL", () => {
    process.env.VERCEL_URL = "jubelio-accurate-staging-h5v1jd4q8.vercel.app";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://ecommerce.asiacommerce.id";
    expect(continuationUrl("https://jubelio-accurate-staging-h5v1jd4q8.vercel.app/api/cron/jubelio?schedule=weekly")).toBe(
      "https://ecommerce.asiacommerce.id/api/cron/jubelio?schedule=weekly",
    );
  });

  it("schedules a promise and does not follow redirects", async () => {
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const seen: Promise<unknown>[] = [];
    let called = "";
    let redirect: RequestRedirect | undefined;
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
        redirect = init?.redirect;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cron-secret");
        expect(new Headers(init?.headers).get("x-job-chain")).toBe("1");
        return new Response("{}", { status: 202 });
      },
    );
    await seen[0];
    expect(called).toBe("https://ecommerce.asiacommerce.id/api/cron/jubelio?schedule=daily");
    expect(redirect).toBe("manual");
  });

  it("logs only the status when the continuation is redirected to SSO", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const status = await postContinuation(
        async (_url, init) => {
          expect(init?.redirect).toBe("manual");
          return new Response("sign in", { status: 302, headers: { location: "https://vercel.com/sso-api?next=secret" } });
        },
        "https://ecommerce.asiacommerce.id/api/cron/jubelio?schedule=daily",
        continuationHeaders("Bearer cron-secret", 1, "bypass-secret"),
      );
      expect(status).toBe(302);
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([["Rantai cron Jubelio ditolak (302)."]]);
    expect(JSON.stringify(logged)).not.toContain("bypass-secret");
    expect(JSON.stringify(logged)).not.toContain("sso-api");
  });

  it("sends a protection bypass when one is configured", () => {
    const headers = continuationHeaders("Bearer cron-secret", 2, "bypass-secret");
    expect(headers["x-vercel-protection-bypass"]).toBe("bypass-secret");
    expect(headers.authorization).toBe("Bearer cron-secret");
    expect(headers["x-job-chain"]).toBe("3");
  });

  it("lets the next step claim a running job whose lease was already released", () => {
    const now = Date.parse("2026-11-03T10:03:00.000Z");
    expect(canClaim({ status: "running", leaseToken: null, leaseUntil: null }, "next", now)).toBe("claim");
    expect(canClaim({ status: "running", leaseToken: "old", leaseUntil: "2026-11-03T09:34:00.000Z" }, "next", now)).toBe("claim");
  });
});

function restore(name: "VERCEL_URL" | "VERCEL_BRANCH_URL" | "VERCEL_PROJECT_PRODUCTION_URL" | "NEXT_PUBLIC_APP_URL" | "VERCEL_AUTOMATION_BYPASS_SECRET", value: string | undefined) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
