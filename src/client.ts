/**
 * Thin HTTP client for the legislation.govt.nz developer API and its legacy
 * Atom feeds.
 *
 * Handles authentication, JSON decoding, polite retry on transient upstream
 * errors, mapping error status codes to readable messages, and capturing the
 * X-RateLimit-* response headers so tools can report remaining quota.
 *
 * Docs: https://api.legislation.govt.nz/docs/
 *
 * Two hosts, two keys (verified live, September 2026):
 *   - JSON API   https://api.legislation.govt.nz/v0/...
 *       auth: X-Api-Key header, LEGISLATION_NZ_API_KEY, 10,000 requests/day.
 *   - Feeds      https://www.legislation.govt.nz/api/rss/...
 *       auth: api_key query parameter only (the header is ignored),
 *       LEGISLATION_NZ_RSS_API_KEY — a separate RSS-only key; the v0 key is
 *       rejected there — 1,500 requests/day.
 */

const API_BASE_URL = "https://api.legislation.govt.nz";
const FEED_BASE_URL = "https://www.legislation.govt.nz";

/** Raised for any non-success response so tools can surface a clean message. */
export class LegislationApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LegislationApiError";
  }
}

function apiKey(): string {
  const key = process.env.LEGISLATION_NZ_API_KEY;
  if (!key) {
    throw new LegislationApiError(
      "LEGISLATION_NZ_API_KEY is not set. Add it to your environment (see .env.example).",
    );
  }
  return key;
}

function rssApiKey(): string {
  const key = process.env.LEGISLATION_NZ_RSS_API_KEY;
  if (!key) {
    throw new LegislationApiError(
      "LEGISLATION_NZ_RSS_API_KEY is not set. The legacy feeds use a separate RSS-only key " +
        "(the v0 API key is rejected there). Add it to your environment (see .env.example).",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Rate-limit headers
// ---------------------------------------------------------------------------

/** Which daily quota a request counts against. */
export type RateLimitScope = "api" | "rss";

export interface RateLimitSnapshot {
  /** Requests permitted per day for this key (X-RateLimit-Limit). */
  limit: number;
  /** Requests remaining in the current period (X-RateLimit-Remaining). */
  remaining: number;
  /** When the quota resets, ISO 8601 UTC (X-RateLimit-Reset). This is midnight NZ time. */
  resets_at: string;
  /** The same instant in New Zealand local time. */
  resets_at_nz: string;
  /** When these values were observed, ISO 8601 UTC. */
  observed_at: string;
}

const rateLimits: Partial<Record<RateLimitScope, RateLimitSnapshot>> = {};
let lastScope: RateLimitScope | undefined;

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse the X-RateLimit-* headers off a response and remember them. */
function recordRateLimit(scope: RateLimitScope, headers: Headers): void {
  const limit = headerNumber(headers, "x-ratelimit-limit");
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const reset = headerNumber(headers, "x-ratelimit-reset");
  if (limit === undefined || remaining === undefined || reset === undefined) return;
  const resetDate = new Date(reset * 1000);
  rateLimits[scope] = {
    limit,
    remaining,
    resets_at: resetDate.toISOString(),
    resets_at_nz: resetDate.toLocaleString("en-NZ", {
      timeZone: "Pacific/Auckland",
      timeZoneName: "short",
    }),
    observed_at: new Date().toISOString(),
  };
  lastScope = scope;
}

/**
 * Latest observed quota per scope. A scope is absent until a request has been
 * made against it in this process.
 */
export function getRateLimitStatus(): Partial<Record<RateLimitScope, RateLimitSnapshot>> {
  return { ...rateLimits };
}

/** Quota reported by the most recent response, tagged with its scope. */
export function lastRateLimit():
  | { scope: RateLimitScope; limit: number; remaining: number; resets_at: string; resets_at_nz: string }
  | undefined {
  if (!lastScope) return undefined;
  const snap = rateLimits[lastScope];
  if (!snap) return undefined;
  return {
    scope: lastScope,
    limit: snap.limit,
    remaining: snap.remaining,
    resets_at: snap.resets_at,
    resets_at_nz: snap.resets_at_nz,
  };
}

// ---------------------------------------------------------------------------
// Errors and retries
// ---------------------------------------------------------------------------

/** Human-readable messages for the documented error codes. */
function messageForStatus(scope: RateLimitScope, status: number, body: string): string {
  switch (status) {
    case 401:
      return scope === "rss"
        ? "Unauthorized (401): the feed API key is missing or invalid. The legacy feeds need a " +
            "separate RSS-only key (LEGISLATION_NZ_RSS_API_KEY); the v0 API key is rejected."
        : "Unauthorized (401): the API key is missing or invalid (LEGISLATION_NZ_API_KEY).";
    case 403:
      return (
        "Forbidden (403): burst limit exceeded (2,000 requests / 5 minutes per IP). " +
        "Wait five minutes before retrying."
      );
    case 404:
      return "Not found (404): no resource matches that identifier.";
    case 429: {
      const snap = rateLimits[scope];
      const quota = snap
        ? `${snap.limit.toLocaleString("en-NZ")} requests/day`
        : scope === "rss"
          ? "1,500 requests/day"
          : "10,000 requests/day";
      const reset = snap
        ? ` Quota resets at ${snap.resets_at} (${snap.resets_at_nz}).`
        : " The quota resets at midnight NZ time.";
      return `Rate limited (429): daily quota exceeded (${quota} per key).${reset}`;
    }
    default:
      return `Request failed (${status}): ${body.slice(0, 300)}`;
  }
}

const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 10_000;
/** Per-attempt limit on a request, covering both the response and its body. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Transient upstream failures worth a short retry. 429 is deliberately absent:
 * it means the daily quota is spent until midnight NZ time, so retrying within
 * a tool call cannot succeed.
 */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** True for the error fetch throws when AbortSignal.timeout fires. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/** Sleep helper for backoff between retries. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After seconds when present and sane, else exponential; always capped. */
function backoffMs(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2 ** attempt * 1000;
  return Math.min(ms, MAX_BACKOFF_MS);
}

type Params = Record<string, string | number | undefined>;

function withParams(url: URL, params: Params): URL {
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}

interface RequestOptions {
  /** Record X-RateLimit-* headers from the response (default true). */
  recordHeaders?: boolean;
  /** A secret to scrub from any error body before it reaches a message. */
  redact?: string;
}

/** Shared fetch loop: records quota headers, maps errors, retries transient failures. */
async function request(
  scope: RateLimitScope,
  url: URL,
  init: RequestInit,
  opts: RequestOptions = {},
): Promise<string> {
  const record = opts.recordHeaders ?? true;
  let lastError: LegislationApiError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (record) recordRateLimit(scope, res.headers);

      if (res.ok) return await res.text();
    } catch (err) {
      if (!isTimeout(err)) throw err;
      // The URL is left out of the message: feed URLs carry the key.
      lastError = new LegislationApiError(
        `Request timed out: the upstream server did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
      );
      if (attempt < MAX_RETRIES) {
        await delay(backoffMs(null, attempt));
        continue;
      }
      throw lastError;
    }

    let body = await res.text().catch(() => "");
    if (opts.redact) body = body.split(opts.redact).join("<redacted>");
    lastError = new LegislationApiError(messageForStatus(scope, res.status, body), res.status);

    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      await delay(backoffMs(res.headers.get("retry-after"), attempt));
      continue;
    }
    throw lastError;
  }
  throw lastError ?? new LegislationApiError("Request failed after retries.");
}

// ---------------------------------------------------------------------------
// JSON API (api.legislation.govt.nz)
// ---------------------------------------------------------------------------

/** Perform a GET against the JSON API and return the raw text body. */
export async function getRaw(
  path: string,
  params: Params = {},
  accept = "application/json",
): Promise<string> {
  const url = withParams(new URL(path, API_BASE_URL), params);
  return request("api", url, { headers: { "X-Api-Key": apiKey(), Accept: accept } });
}

/** GET and parse the body as JSON. */
export async function getJson<T = unknown>(path: string, params: Params = {}): Promise<T> {
  const text = await getRaw(path, params, "application/json");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LegislationApiError("API returned a response that was not valid JSON.");
  }
}

/**
 * Fetch a document format URL (the absolute URLs found in a version's
 * `formats[]`). PCO-published documents live on the legislation host and need
 * the key. Agency-published secondary legislation can link to the agency's own
 * website; the key is never sent to those hosts, and their headers are ignored.
 */
export async function getDocument(url: string): Promise<string> {
  const target = new URL(url);
  const onLegislationHost = target.hostname.endsWith("legislation.govt.nz");
  const headers: Record<string, string> = onLegislationHost ? { "X-Api-Key": apiKey() } : {};
  return request("api", target, { headers }, { recordHeaders: onLegislationHost });
}

// ---------------------------------------------------------------------------
// Legacy feeds (www.legislation.govt.nz/api/rss/)
// ---------------------------------------------------------------------------

/** The public URL of a feed, without the key, for subscribing in a feed reader. */
export function feedUrl(path: string, params: Params = {}): string {
  return withParams(new URL(path, FEED_BASE_URL), params).toString();
}

/**
 * Fetch a legacy feed and return the Atom XML. The feeds only accept the key
 * as a query parameter, so it is appended here and scrubbed from any error.
 */
export async function getFeed(path: string, params: Params = {}): Promise<string> {
  const key = rssApiKey();
  const url = withParams(new URL(path, FEED_BASE_URL), { ...params, api_key: key });
  return request(
    "rss",
    url,
    { headers: { Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8" } },
    { redact: key },
  );
}
