import { z } from "zod";
import { getJson } from "../client.js";
import type { Version } from "../types.js";
import {
  unwrapResults,
  totalOf,
  dateFromVersionId,
  workUrl,
  versionUrl,
  isEphemeral,
  type Paginated,
} from "../util.js";

/** The API caps per_page at 100 on this endpoint (verified live). */
const MAX_PER_PAGE = 100;
/** Safety cap when fetching every page: 20 × 100 = 2,000 versions. */
const MAX_PAGES = 20;

export const versionsInputSchema = {
  work_id: z
    .string()
    .describe("The work_id from a search result (e.g. \"act_public_2020_31\")."),
  sort: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Order versions by date, ascending or descending (default desc = newest first)."),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Fetch only this page of results. Omit to fetch every page and return all versions."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .optional()
    .describe(`Page size (default ${MAX_PER_PAGE}, the API maximum).`),
};

const schema = z.object(versionsInputSchema);

/** Per-version fields. `title` appears only if it differs from the work's title. */
function summarize(v: Version, workTitle: string | undefined, isLatest: boolean) {
  return {
    version_id: v.version_id,
    version_date: dateFromVersionId(v.version_id),
    url: versionUrl(v.version_id),
    ephemeral: isEphemeral(v.version_id),
    is_latest_version: isLatest ? true : undefined,
    title: v.title !== workTitle ? v.title : undefined,
    formats: (v.formats ?? []).map((f) => f.type).filter(Boolean),
  };
}

/**
 * Work-level metadata. The API repeats these fields on every version and they
 * are identical across versions (checked live on a repealed Act and an enacted
 * Bill), so they are reported once rather than per entry.
 */
function workMeta(workId: string, v: Version | undefined) {
  return {
    work_id: workId,
    title: v?.title,
    url: workUrl(workId),
    ephemeral: isEphemeral(workId),
    legislation_type: v?.legislation_type,
    legislation_status: v?.legislation_status,
    administering_agencies: v?.administering_agencies,
    act_type: v?.act_type,
    act_status: v?.act_status,
    act_classification: v?.act_classification,
    bill_type: v?.bill_type,
    bill_status: v?.bill_status,
    instrument_type_group: v?.instrument_type_group,
    instrument_status: v?.instrument_status,
    instrument_classification: v?.instrument_classification,
  };
}

/**
 * The versions endpoint does not send is_latest_version (only search does), so
 * derive it from the ordering: with the default descending sort the newest
 * version is first; ascending, it is last. Returns -1 when the newest version
 * is not within the fetched range.
 */
function latestIndex(
  count: number,
  sort: "asc" | "desc" | undefined,
  isFirstPage: boolean,
  isLastPage: boolean,
): number {
  if (count === 0) return -1;
  if (sort === "asc") return isLastPage ? count - 1 : -1;
  return isFirstPage ? 0 : -1;
}

export async function listVersions(args: z.infer<typeof schema>) {
  const path = `/v0/works/${encodeURIComponent(args.work_id)}/versions/`;
  const perPage = args.per_page ?? MAX_PER_PAGE;
  const fetchPage = (page: number) =>
    getJson<Paginated<Version>>(path, { sort: args.sort, page, per_page: perPage });

  // Single-page mode.
  if (args.page !== undefined) {
    const data = await fetchPage(args.page);
    const versions = unwrapResults(data);
    const total = totalOf(data);
    const hasMore = total !== undefined ? args.page * perPage < total : versions.length === perPage;
    const latest = latestIndex(versions.length, args.sort, args.page === 1, !hasMore);
    const meta = workMeta(args.work_id, versions[0]);
    return {
      ...meta,
      total,
      page: args.page,
      per_page: perPage,
      count: versions.length,
      has_more: hasMore,
      versions: versions.map((v, i) => summarize(v, meta.title, i === latest)),
    };
  }

  // Fetch every page until the total is reached or a short page ends the list.
  const all: Version[] = [];
  let total: number | undefined;
  let pagesFetched = 0;
  while (pagesFetched < MAX_PAGES) {
    const data = await fetchPage(pagesFetched + 1);
    pagesFetched++;
    const versions = unwrapResults(data);
    total ??= totalOf(data);
    all.push(...versions);
    if (versions.length < perPage) break;
    if (total !== undefined && all.length >= total) break;
  }
  const truncated = total !== undefined && all.length < total;
  const latest = latestIndex(all.length, args.sort, true, !truncated);
  const meta = workMeta(args.work_id, all[0]);
  return {
    ...meta,
    total: total ?? all.length,
    count: all.length,
    pages_fetched: pagesFetched,
    truncated,
    versions: all.map((v, i) => summarize(v, meta.title, i === latest)),
  };
}
