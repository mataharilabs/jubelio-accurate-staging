import { after } from "next/server";
import { shouldContinueChain } from "@/lib/jubelio/schedule";

export type ContinuationSchedule = (task: Promise<unknown>) => void;

function deploymentHosts(): Set<string> {
  return new Set(
    [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value)),
  );
}

/** Unique deployment hosts (VERCEL_URL) sit behind Vercel Authentication. The stable production alias and custom domains do not. */
export function isProductionHost(hostname: string): boolean {
  return !deploymentHosts().has(hostname.trim().toLowerCase());
}

function absoluteOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

/**
 * Prefer the request origin when it is a production host. Otherwise use
 * VERCEL_PROJECT_PRODUCTION_URL, then NEXT_PUBLIC_APP_URL. Never VERCEL_URL:
 * that host redirects to Vercel SSO.
 */
export function continuationUrl(requestUrl: string): string {
  const incoming = new URL(requestUrl);
  const path = `${incoming.pathname}${incoming.search}`;
  if (isProductionHost(incoming.hostname)) return new URL(path, incoming.origin).toString();
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return new URL(path, absoluteOrigin(production)).toString();
  const app = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (app) return new URL(path, absoluteOrigin(app)).toString();
  return incoming.toString();
}

export function continuationHeaders(authorization: string, chain: number, bypass?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    authorization,
    "x-job-chain": String(chain + 1),
  };
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return headers;
}

/** Next.js runs a function passed to after() only after the request closes, and waits to close until that function finishes. Pass the promise itself so waitUntil starts it immediately. */
export function enqueueContinuation(schedule: ContinuationSchedule, task: Promise<unknown>) {
  schedule(task);
}

export function continuationRejected(status: number): boolean {
  return status < 200 || status >= 300;
}

export async function postContinuation(fetchImpl: typeof fetch, target: string, headers: Record<string, string>): Promise<number> {
  const response = await fetchImpl(target, { method: "GET", headers, cache: "no-store", redirect: "manual" });
  await response.arrayBuffer().catch(() => undefined);
  if (continuationRejected(response.status)) console.error(`Rantai cron Jubelio ditolak (${response.status}).`);
  return response.status;
}

/** Starts the next step. Returns null when this worker should not chain. */
export function chainNext(
  target: string | URL,
  authorization: string,
  chain: number,
  running: boolean,
  busy: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<number> | null {
  if (!authorization || !shouldContinueChain({ busy, running, chain })) return null;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null;
  return postContinuation(fetchImpl, continuationUrl(String(target)), continuationHeaders(authorization, chain, bypass));
}

/** Schedules the next cron step from a top-level request. Passes a promise so waitUntil starts it immediately. */
export function continueCron(
  target: string | URL,
  authorization: string,
  chain: number,
  running: boolean,
  busy: boolean,
  schedule: ContinuationSchedule = after,
  fetchImpl: typeof fetch = fetch,
) {
  const task = chainNext(target, authorization, chain, running, busy, fetchImpl);
  if (task) enqueueContinuation(schedule, task);
}
