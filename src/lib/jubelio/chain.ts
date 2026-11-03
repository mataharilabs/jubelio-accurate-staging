import { after } from "next/server";
import { shouldContinueChain } from "@/lib/jubelio/schedule";

export type ContinuationSchedule = (task: Promise<unknown>) => void;

/**
 * Same deployment that is running this invocation. A fetch to request.url can
 * miss the function (custom domain or deployment protection) and leave no log.
 */
export function continuationUrl(requestUrl: string): string {
  const incoming = new URL(requestUrl);
  const host = process.env.VERCEL_URL?.trim();
  if (!host) return incoming.toString();
  return new URL(`${incoming.pathname}${incoming.search}`, `https://${host}`).toString();
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

export async function postContinuation(fetchImpl: typeof fetch, target: string, headers: Record<string, string>): Promise<number> {
  const response = await fetchImpl(target, { method: "GET", headers, cache: "no-store" });
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) console.error(`Rantai cron Jubelio ditolak (${response.status}).`);
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
