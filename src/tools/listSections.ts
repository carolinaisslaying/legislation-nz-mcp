import { z } from "zod";
import { getJson, getDocument, LegislationApiError } from "../client.js";
import { parseLegislation, buildStructure, documentKind } from "../xml.js";
import { dateFromVersionId, versionUrl } from "../util.js";
import { resolveVersion } from "./resolve.js";
import type { Version } from "../types.js";

export const listSectionsInputSchema = {
  version_id: z
    .string()
    .optional()
    .describe("A specific version to inspect. Provide either version_id or work_id."),
  work_id: z
    .string()
    .optional()
    .describe("A work_id; resolved to the newest version dated on or before today, or on or before as_at. Provide either version_id or work_id."),
  as_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the form YYYY-MM-DD.")
    .optional()
    .describe(
      "With work_id: read the version in force on this date (YYYY-MM-DD), i.e. the newest version dated on or before it. " +
      "Without as_at, work_id resolves to the newest version dated on or before today (NZ time). Cannot be combined with version_id.",
    ),
};

const schema = z.object(listSectionsInputSchema);

export async function listSections(args: z.infer<typeof schema>) {
  const { version_id: versionId, ...selection } = await resolveVersion(args);

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
    url: versionUrl(versionId),
    ...selection,
    note:
      documentKind(root) === "sop"
        ? "This is an amendment paper: it has no sections of its own, only proposed amendments to a bill. Read the whole paper with get_legislation_text."
        : undefined,
    ...structure,
  };
}
