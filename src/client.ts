/**
 * Thin HTTP client for the legislation.govt.nz developer API.
 *
 * Handles authentication (X-Api-Key header), JSON decoding, polite retry on
 * rate-limit / transient errors, and mapping API error status codes to
 * readable messages.
 *
 * Docs: https://api.legislation.govt.nz/docs/
 */

const BASE_URL = "https://api.legislation.govt.nz";

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

/** Human-readable messages for the documented error codes. */
function messageForStatus(status: number, body: string): string {
  switch (status) {
    case 401:
      return "Unauthorized (401): the API key is missing or invalid.";
    case 403:
      return "Forbidden (403): burst limit exceeded (2,000 requests / 5 minutes per IP).";
    case 404:
      return "Not found (404): no resource matches that identifier.";
    case 429:
      return "Rate limited (429): daily quota exceeded (10,000 requests/day per key).";
    default:
      return `Request failed (${status}): ${body.slice(0, 300)}`;
  }
}

const MAX_RETRIES = 3;

/** Sleep helper for backoff between retries. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a GET against the API and return the raw text body.
 * Retries once on 429/503 with backoff (honouring Retry-After when present).
 */
export async function getRaw(
  path: string,
  params: Record<string, string | number | undefined> = {},
  accept = "application/json",
): Promise<string> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  let lastError: LegislationApiError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { "X-Api-Key": apiKey(), Accept: accept },
    });

    if (res.ok) return await res.text();

    const body = await res.text().catch(() => "");
    lastError = new LegislationApiError(messageForStatus(res.status, body), res.status);

    // Retry only on transient throttling / upstream errors.
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 1000;
      await delay(backoff);
      continue;
    }
    throw lastError;
  }
  throw lastError ?? new LegislationApiError("Request failed after retries.");
}

/** GET and parse the body as JSON. */
export async function getJson<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const text = await getRaw(path, params, "application/json");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LegislationApiError("API returned a response that was not valid JSON.");
  }
}

/**
 * Fetch an arbitrary document format URL (the absolute URLs found in a
 * version's `formats[]`). These are on the same host and still require the key.
 */
export async function getDocument(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "X-Api-Key": apiKey() } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LegislationApiError(messageForStatus(res.status, body), res.status);
  }
  return await res.text();
}
