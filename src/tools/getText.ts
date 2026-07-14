import { z } from "zod";
import { getJson, getDocument, LegislationApiError } from "../client.js";
import { htmlToText, xmlToText, truncate } from "../format.js";
import type { Version } from "../types.js";
import { unwrapResults, dateFromVersionId, type Paginated } from "../util.js";

const DEFAULT_MAX_CHARS = 100_000;

export const getTextInputSchema = {
  version_id: z
    .string()
    .optional()
    .describe("A specific version to read. Provide either version_id or work_id."),
  work_id: z
    .string()
    .optional()
    .describe("A work_id; the newest version will be resolved automatically. Provide either version_id or work_id."),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe(`Truncate the returned text to this many characters (default ${DEFAULT_MAX_CHARS}) to protect the token budget.`),
};

const schema = z.object(getTextInputSchema);

/** Find a format URL by type ("xml", "html", ...) on a version, if present. */
function formatUrl(v: Version, type: string): string | undefined {
  return (v.formats ?? []).find((f) => (f.type ?? "").toLowerCase() === type)?.url;
}

/** Resolve a work_id to the version_id of its newest version. */
async function newestVersionId(workId: string): Promise<string> {
  const data = await getJson<Paginated<Version>>(
    `/v0/works/${encodeURIComponent(workId)}/versions/`,
    { sort: "desc" },
  );
  const versions = unwrapResults(data);
  const id = versions[0]?.version_id;
  if (!id) {
    throw new LegislationApiError(`No versions found for work_id "${workId}".`);
  }
  return id;
}

export async function getLegislationText(args: z.infer<typeof schema>) {
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

  // Prefer XML: it contains only the legislation content. The `html` format is
  // the full website page (navigation, chrome) and is used only as a fallback.
  const xmlUrl = formatUrl(version, "xml");
  const htmlUrl = formatUrl(version, "html");
  const url = xmlUrl ?? htmlUrl;
  if (!url) {
    const available = (version.formats ?? []).map((f) => f.type).join(", ") || "none";
    throw new LegislationApiError(
      `No XML or HTML format available for version "${versionId}" (available: ${available}).`,
    );
  }

  const source = xmlUrl ? "xml" : "html";
  const raw = await getDocument(url);
  const text = source === "xml" ? xmlToText(raw) : htmlToText(raw);
  const { text: out, truncated } = truncate(text, args.max_chars ?? DEFAULT_MAX_CHARS);

  return {
    version_id: versionId,
    work_id: version.work_id,
    title: version.title,
    version_date: dateFromVersionId(versionId),
    source_url: url,
    source_format: source,
    truncated,
    text: out,
  };
}
