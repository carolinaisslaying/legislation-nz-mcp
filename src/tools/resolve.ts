import { getJson } from "../client.js";
import { LegislationApiError } from "../client.js";
import { unwrapResults, type Paginated } from "../util.js";
import type { Version } from "../types.js";

/** Resolve a work_id to the version_id of its newest version. */
export async function newestVersionId(workId: string): Promise<string> {
  // Only the first entry is needed; keep the response small.
  const data = await getJson<Paginated<Version>>(
    `/v0/works/${encodeURIComponent(workId)}/versions/`,
    { sort: "desc", per_page: 1 },
  );
  const versions = unwrapResults(data);
  const id = versions[0]?.version_id;
  if (!id) {
    throw new LegislationApiError(`No versions found for work_id "${workId}".`);
  }
  return id;
}
