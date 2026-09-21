import { z } from "zod";
import { getJson } from "../client.js";
import type { Version } from "../types.js";
import { dateFromVersionId, versionUrl, workUrl, isEphemeral } from "../util.js";

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
    url: versionUrl(v.version_id),
    work_url: workUrl(v.work_id),
    ephemeral: isEphemeral(v.version_id),
    version_date: dateFromVersionId(v.version_id),
    legislation_type: v.legislation_type,
    legislation_status: v.legislation_status,
    administering_agencies: v.administering_agencies,
    act_type: v.act_type,
    act_status: v.act_status,
    act_classification: v.act_classification,
    bill_type: v.bill_type,
    bill_status: v.bill_status,
    instrument_type_group: v.instrument_type_group,
    instrument_status: v.instrument_status,
    instrument_classification: v.instrument_classification,
    is_latest_version: v.is_latest_version,
    formats: (v.formats ?? []).map((f) => ({ type: f.type, url: f.url })),
  };
}
