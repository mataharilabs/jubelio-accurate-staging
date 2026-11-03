import { after } from "next/server";
import { shouldContinueChain } from "@/lib/jubelio/schedule";

/** Schedules the next cron step after the response. Only the worker that holds the lease should call this. */
export function continueCron(target: string | URL, authorization: string, chain: number, running: boolean, busy: boolean) {
  if (!authorization || !shouldContinueChain({ busy, running, chain })) return;
  const headers = { authorization, "x-job-chain": String(chain + 1) };
  after(() => fetch(target, { headers, cache: "no-store" }).catch(() => undefined));
}
