import tls from "node:tls";
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

export type ContinuationTransport = (target: string, headers: Record<string, string>) => Promise<number>;

function safeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** The request a raw TLS connection sends. Fetch and http.request are not used: Vercel tags those with x-vercel-id and answers a self-call with 508. */
export function continuationRequest(target: string, headers: Record<string, string>): { host: string; port: number; servername: string; payload: string } {
  const url = new URL(target);
  const path = `${url.pathname}${url.search}` || "/";
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: close",
    "User-Agent: jubelio-cron-chain",
    ...Object.entries(headers).map(([key, value]) => `${safeHeader(key)}: ${safeHeader(value)}`),
    "",
    "",
  ];
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 443,
    servername: url.hostname,
    payload: lines.join("\r\n"),
  };
}

export function statusFromHead(head: string): number | null {
  const match = /^HTTP\/\d+(?:\.\d+)? (\d{3})/.exec(head);
  return match ? Number(match[1]) : null;
}

const DISPATCH_TIMEOUT_MS = 10_000;

/** Opens a TLS socket and reads only the status line. A 3xx is returned as-is and is not followed. */
export function dispatchContinuation(target: string, headers: Record<string, string>, timeoutMs = DISPATCH_TIMEOUT_MS): Promise<number> {
  const request = continuationRequest(target, headers);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: request.host,
      port: request.port,
      servername: request.servername,
      rejectUnauthorized: true,
    });
    let head = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    const finish = (error?: Error, status?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(status ?? 0);
    };
    socket.once("secureConnect", () => {
      socket.write(request.payload);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      head += chunk.toString("latin1");
      const status = statusFromHead(head);
      if (status != null) finish(undefined, status);
      else if (head.length > 1024) finish(new Error("no status"));
    });
    socket.once("error", (error: Error) => finish(error));
    socket.once("end", () => {
      const status = statusFromHead(head);
      if (status == null) finish(new Error("no status"));
      else finish(undefined, status);
    });
  });
}

const RETRYABLE_STATUS = new Set([0, 508]);

export async function postContinuation(target: string, headers: Record<string, string>, transport: ContinuationTransport = dispatchContinuation): Promise<number> {
  const once = async () => {
    try {
      return await transport(target, headers);
    } catch {
      return 0;
    }
  };
  let status = await once();
  if (RETRYABLE_STATUS.has(status)) status = await once();
  if (continuationRejected(status)) console.error(`Rantai cron Jubelio ditolak (${status}).`);
  return status;
}

/** Starts the next step. Returns null when this worker should not chain. */
export function chainNext(
  target: string | URL,
  authorization: string,
  chain: number,
  running: boolean,
  busy: boolean,
  transport: ContinuationTransport = dispatchContinuation,
): Promise<number> | null {
  if (!authorization || !shouldContinueChain({ busy, running, chain })) return null;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null;
  return postContinuation(continuationUrl(String(target)), continuationHeaders(authorization, chain, bypass), transport);
}

/** Schedules the next cron step from a top-level request. Passes a promise so waitUntil starts it immediately. */
export function continueCron(
  target: string | URL,
  authorization: string,
  chain: number,
  running: boolean,
  busy: boolean,
  schedule: ContinuationSchedule = after,
  transport: ContinuationTransport = dispatchContinuation,
) {
  const task = chainNext(target, authorization, chain, running, busy, transport);
  if (task) enqueueContinuation(schedule, task);
}
