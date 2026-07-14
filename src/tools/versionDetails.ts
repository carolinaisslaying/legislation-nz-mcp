import { z } from "zod";
import { getJson } from "../client.js";
import type { Version } from "../types.js";
import { dateFromVersionId } from "../util.js";

export const versionDetailsInputSchema = {
  version_id: z
    .string()
    .describe("A version_id from a search result or list_versions call."),
};

const schema = z.object(versionDetailsInputSchema);

export async function getVersionDetails(args: z.infer<typeof schema>) {
  const v = await getJson<Version>(
    `/v0/versions/${encodeURIComponent(args.version_id)}/`,
  );
  return {
    version_id: v.version_id,
    work_id: v.work_id,
    title: v.title,
    version_date: dateFromVersionId(v.version_id),
    legislation_status: v.legislation_status,
    formats: (v.formats ?? []).map((f) => ({ type: f.type, url: f.url })),
  };
}
