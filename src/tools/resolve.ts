import { getJson } from "../client.js";
import { LegislationApiError } from "../client.js";
import { unwrapResults, dateFromVersionId, type Paginated } from "../util.js";
import type { Version } from "../types.js";

/** The API's page-size cap on the versions endpoint. */
const PER_PAGE = 100;
/** Safety cap: 20 × 100 = 2,000 versions. */
const MAX_PAGES = 20;

/** The calendar date in New Zealand (YYYY-MM-DD) at the given instant. */
export function nzDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(at);
}

/**
 * Sort key for a version id: its date then any suffix letter, so that
 * `..._2025-11-27` < `..._2025-11-27B` < `..._2025-11-27C`.
 */
function versionKey(versionId: string): string | undefined {
  const m = versionId.match(/(\d{4}-\d{2}-\d{2}[A-Za-z]*)$/);
  return m?.[1];
}

/** The newest version dated on or before `date` (YYYY-MM-DD), if any. */
export function pickVersionAsAt(versionIds: string[], date: string): string | undefined {
  let best: string | undefined;
  let bestKey = "";
  for (const id of versionIds) {
    const key = versionKey(id);
    if (!key || key.slice(0, 10) > date) continue;
    if (key > bestKey) {
      best = id;
      bestKey = key;
    }
  }
  return best;
}

export interface VersionSelection {
  version_id: string;
  /** How the version was chosen when no version_id was given. */
  selected_by?: "as_at" | "latest_current";
  as_at?: string;
  /** Versions dated after today, skipped when resolving "latest". */
  newer_versions_not_yet_current?: string[];
}

/**
 * Resolve the version to read: an explicit version_id, or for a work_id the
 * newest version dated on or before as_at, or on or before today in New
 * Zealand when as_at is omitted (so a future-dated version is never served
 * as current law).
 */
export async function resolveVersion(args: {
  version_id?: string;
  work_id?: string;
  as_at?: string;
}): Promise<VersionSelection> {
  if (args.version_id) {
    if (args.as_at) {
      throw new LegislationApiError("as_at selects a version of a work_id; it cannot be combined with version_id.");
    }
    return { version_id: args.version_id };
  }
  if (!args.work_id) {
    throw new LegislationApiError("Provide either version_id or work_id.");
  }
  const target = args.as_at ?? nzDate();
  const path = `/v0/works/${encodeURIComponent(args.work_id)}/versions/`;
  // Newest first, so the wanted version is normally on the first page.
  const seen: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const versions = unwrapResults(
      await getJson<Paginated<Version>>(path, { sort: "desc", page, per_page: PER_PAGE }),
    );
    seen.push(...versions.map((v) => v.version_id).filter(Boolean));
    const found = versions.some((v) => (dateFromVersionId(v.version_id) ?? "9999") <= target);
    if (found || versions.length < PER_PAGE) break;
  }
  if (!seen.length) {
    throw new LegislationApiError(`No versions found for work_id "${args.work_id}".`);
  }
  const id = pickVersionAsAt(seen, target);
  if (!id) {
    const earliest = [...seen].sort((a, b) => (versionKey(a) ?? "").localeCompare(versionKey(b) ?? ""))[0];
    throw new LegislationApiError(
      `No version of "${args.work_id}" is dated on or before ${target}. Its earliest version is ${earliest} (${dateFromVersionId(earliest)}).`,
    );
  }
  if (args.as_at) return { version_id: id, selected_by: "as_at", as_at: args.as_at };
  const newer = seen.filter((v) => (dateFromVersionId(v) ?? "") > target);
  return {
    version_id: id,
    selected_by: "latest_current",
    newer_versions_not_yet_current: newer.length ? newer : undefined,
  };
}
