/**
 * Small helpers for normalising the API's actual response shapes, and for
 * turning identifiers into website links.
 *
 * The list endpoints (`/v0/works/`, `/v0/works/{id}/versions/`) wrap their items
 * in a paginated envelope: `{ results, total, page, per_page }`. There is no
 * separate date field on versions — the date is encoded in the trailing segment
 * of the `version_id` (e.g. `act_public_2020_31_en_2026-05-01`).
 */

/** Envelope returned by the paginated list endpoints. */
export interface Paginated<T> {
  results?: T[];
  total?: number;
  page?: number;
  per_page?: number;
}

/** Extract the item array whether the API returns an envelope or a bare array. */
export function unwrapResults<T>(data: Paginated<T> | T[]): T[] {
  if (Array.isArray(data)) return data;
  return data.results ?? [];
}

/** Pull the pagination total, if present. */
export function totalOf<T>(data: Paginated<T> | T[]): number | undefined {
  return Array.isArray(data) ? data.length : data.total;
}

/**
 * Derive the effective-date of a version from its id. Version ids end in an
 * ISO date (`..._YYYY-MM-DD`); return it, or undefined if not present.
 */
export function dateFromVersionId(versionId?: string): string | undefined {
  if (!versionId) return undefined;
  // The date sits at the end, but may carry a suffix letter that distinguishes
  // multiple versions with the same effective date (e.g. `..._2025-09-23B`).
  const m = versionId.match(/(\d{4}-\d{2}-\d{2})[A-Za-z]*$/);
  return m?.[1];
}

/** Public website root. Identifier segments map onto its URL segments. */
const WEBSITE_BASE = "https://www.legislation.govt.nz";

/**
 * Website URL for a work: `/{type}/{subtype}/{year}/{number}/en/latest/`.
 * The `latest` alias always resolves to the newest version. Only `en` exists.
 */
export function workUrl(workId?: string): string | undefined {
  if (!workId) return undefined;
  const seg = workId.split("_");
  if (seg.length !== 4 || seg.some((s) => s === "")) return undefined;
  return `${WEBSITE_BASE}/${seg.join("/")}/en/latest/`;
}

/**
 * Website URL for a specific version:
 * `/{type}/{subtype}/{year}/{number}/{language}/{version_date}/`.
 */
export function versionUrl(versionId?: string): string | undefined {
  if (!versionId) return undefined;
  const seg = versionId.split("_");
  if (seg.length !== 6 || seg.some((s) => s === "")) return undefined;
  return `${WEBSITE_BASE}/${seg.join("/")}/`;
}

/**
 * `true` when an identifier contains a `~` segment. The API marks such ids as
 * ephemeral: they were built from fallback data and may change later. Returns
 * undefined (so the key is omitted from JSON) otherwise.
 */
export function isEphemeral(id?: string): true | undefined {
  return id?.includes("~") ? true : undefined;
}
