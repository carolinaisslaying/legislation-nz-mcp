/**
 * Who is making the current HTTP request, how many upstream API requests it
 * has made, and the per-person daily cap on those requests.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { LegislationApiError, setUpstreamRequestHook } from "./client.js";
import { nzDate } from "./tools/resolve.js";

export interface RequestContext {
  user: string;
  /** Upstream API requests made while serving this request. */
  upstream: number;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export interface UsageCounter {
  usage(day: string, user: string): number;
  addUsage(day: string, user: string): number;
}

/** In-memory counter, for when there is no state file (LEGISLATION_AUTH=off). */
export function memoryUsageCounter(): UsageCounter {
  const counts = new Map<string, number>();
  return {
    usage: (day, user) => counts.get(`${day} ${user}`) ?? 0,
    addUsage: (day, user) => {
      const key = `${day} ${user}`;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

/**
 * Count every upstream request against the user making it, and refuse once
 * they have made `cap` today (NZ time). A cap of 0 counts without refusing.
 */
export function installDailyCap(cap: number, counter: UsageCounter): void {
  setUpstreamRequestHook(() => {
    const ctx = requestContext.getStore();
    if (!ctx) return;
    const day = nzDate();
    if (cap > 0 && counter.usage(day, ctx.user) >= cap) {
      throw new LegislationApiError(
        `Daily limit reached: ${ctx.user} has made ${cap.toLocaleString("en-NZ")} legislation API requests today, ` +
          "the most this server allows one person. It resets at midnight NZ time.",
      );
    }
    counter.addUsage(day, ctx.user);
    ctx.upstream++;
  });
}
