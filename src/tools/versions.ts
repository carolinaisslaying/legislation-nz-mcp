import { z } from "zod";
import { getJson } from "../client.js";
import type { Version } from "../types.js";
import { unwrapResults, totalOf, dateFromVersionId, type Paginated } from "../util.js";

export const versionsInputSchema = {
  work_id: z
    .string()
    .describe("The work_id from a search result (e.g. \"act_public_2020_0031\")."),
  sort: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Order versions by date, ascending or descending (default desc = newest first)."),
};

const schema = z.object(versionsInputSchema);

export async function listVersions(args: z.infer<typeof schema>) {
  const data = await getJson<Paginated<Version>>(
    `/v0/works/${encodeURIComponent(args.work_id)}/versions/`,
    { sort: args.sort },
  );

  const versions = unwrapResults(data);
  return {
    work_id: args.work_id,
    total: totalOf(data),
    count: versions.length,
    versions: versions.map((v) => ({
      version_id: v.version_id,
      version_date: dateFromVersionId(v.version_id),
      legislation_status: v.legislation_status,
      formats: (v.formats ?? []).map((f) => f.type).filter(Boolean),
    })),
  };
}
