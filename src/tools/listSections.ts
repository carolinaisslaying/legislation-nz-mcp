import { z } from "zod";
import { getJson, getDocument, LegislationApiError } from "../client.js";
import { parseLegislation, buildStructure } from "../xml.js";
import { dateFromVersionId } from "../util.js";
import { newestVersionId } from "./resolve.js";
import type { Version } from "../types.js";

export const listSectionsInputSchema = {
  version_id: z
    .string()
    .optional()
    .describe("A specific version to inspect. Provide either version_id or work_id."),
  work_id: z
    .string()
    .optional()
    .describe("A work_id; the newest version will be used. Provide either version_id or work_id."),
};

const schema = z.object(listSectionsInputSchema);

export async function listSections(args: z.infer<typeof schema>) {
  let versionId = args.version_id;
  if (!versionId) {
    if (!args.work_id) {
      throw new LegislationApiError("Provide either version_id or work_id.");
    }
    versionId = await newestVersionId(args.work_id);
  }

  const version = await getJson<Version>(
    `/v0/versions/${encodeURIComponent(versionId)}/`,
  );

  const xmlUrl = (version.formats ?? []).find(
    (f) => (f.type ?? "").toLowerCase() === "xml",
  )?.url;

  if (!xmlUrl) {
    const available = (version.formats ?? []).map((f) => f.type).join(", ") || "none";
    throw new LegislationApiError(
      `No XML format available for version "${versionId}" (available: ${available}). Structure listing requires XML.`,
    );
  }

  const xml = await getDocument(xmlUrl);
  const root = parseLegislation(xml);
  const structure = buildStructure(root);

  return {
    version_id: versionId,
    work_id: version.work_id,
    title: version.title,
    version_date: dateFromVersionId(versionId),
    ...structure,
  };
}
