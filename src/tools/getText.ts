import { z } from "zod";
import { getJson, getDocument, LegislationApiError } from "../client.js";
import { htmlToText, xmlToText, truncate } from "../format.js";
import { parseLegislation, findSection, findSchedule, type ExcludeOption } from "../xml.js";
import type { Version } from "../types.js";
import { dateFromVersionId } from "../util.js";
import { newestVersionId } from "./resolve.js";

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
  section: z
    .string()
    .optional()
    .describe(
      "Return only this section number (e.g. \"22\" or \"25A\") instead of the whole document. " +
      "Use list_sections first to discover section numbers. Cannot be combined with schedule.",
    ),
  schedule: z
    .string()
    .optional()
    .describe(
      "Return only this schedule number (e.g. \"1\") instead of the whole document. " +
      "Cannot be combined with section.",
    ),
  format: z
    .enum(["pdf"])
    .optional()
    .describe(
      "Set to \"pdf\" to retrieve the official PDF download URL instead of the document text. " +
      "Returns the URL and metadata without downloading the file. " +
      "Cannot be combined with section or schedule.",
    ),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe(`Truncate whole-document output to this many characters (default ${DEFAULT_MAX_CHARS}). Not applied when fetching a single section or schedule.`),
  exclude: z
    .array(
      z.enum(["cover", "history_notes", "comparative_references", "editorial_notes", "defined_term_links", "end_matter"]),
    )
    .optional()
    .describe(
      "Content types to exclude from the rendered text. By default everything is included. " +
      "Options:\n" +
      "- \"cover\": Front-page block (title, assent date, PCO reprint note). " +
        "Already returned as structured metadata fields — exclude to avoid duplication in the text body.\n" +
      "- \"history_notes\": Amendment-history entries at the end of each provision, " +
        "recording when it was inserted, amended, or repealed and by which Act. " +
        "Useful for understanding how law evolved; omit if you only need current text.\n" +
      "- \"comparative_references\": Terse cross-references to equivalent provisions " +
        "in predecessor or overseas legislation (e.g. '1952 No 43 s 4(1)'). " +
        "Lineage information only — not part of the current operative law.\n" +
      "- \"editorial_notes\": Two kinds of PCO annotation: (1) editorial-note elements — " +
        "free-text PCO notes such as secondary legislation compliance tables, " +
        "explicitly flagged in the source as 'not part of the Act'; and " +
        "(2) amends-note elements — machine-readable scheduling data for amendments not yet in force, " +
        "recording the trigger date/event, affected provisions, and replacement text. " +
        "Exclude if you only need the current operative text.\n" +
      "- \"defined_term_links\": Inland Revenue (Income Tax Act) navigation lists " +
        "enumerating which defined terms appear in a provision. " +
        "Website navigation aids only — not legislative text.\n" +
      "- \"end_matter\": Document-tail reprint metadata — the reprint index (table of reprint dates) " +
        "and reprint notes (free-text describing what each reprint changed), plus the leg-history " +
        "element (structured list of reprint issuance dates). " +
        "Appears once at the end of the whole document; not present when fetching a single section.",
    ),
};

const schema = z.object(getTextInputSchema);

/** Find a format URL by type ("xml", "html", ...) on a version, if present. */
function formatUrl(v: Version, type: string): string | undefined {
  return (v.formats ?? []).find((f) => (f.type ?? "").toLowerCase() === type)?.url;
}

export async function getLegislationText(args: z.infer<typeof schema>) {
  if (args.section && args.schedule) {
    throw new LegislationApiError("Provide section or schedule, not both.");
  }
  if (args.format && (args.section || args.schedule)) {
    throw new LegislationApiError("format cannot be combined with section or schedule.");
  }

  const exclude = (args.exclude ?? []) as ExcludeOption[];

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

  const xmlUrl = formatUrl(version, "xml");
  const htmlUrl = formatUrl(version, "html");
  const meta = {
    version_id: versionId,
    work_id: version.work_id,
    title: version.title,
    version_date: dateFromVersionId(versionId),
  };

  // --- PDF URL mode ---
  if (args.format === "pdf") {
    const pdfUrl = formatUrl(version, "pdf") ?? formatUrl(version, "pdf_original_scan");
    if (!pdfUrl) {
      const available = (version.formats ?? []).map((f) => f.type).join(", ") || "none";
      throw new LegislationApiError(
        `No PDF format available for version "${versionId}" (available: ${available}).`,
      );
    }
    return { ...meta, pdf_url: pdfUrl };
  }

  // --- Per-section or per-schedule mode ---
  if (args.section ?? args.schedule) {
    if (!xmlUrl) {
      const available = (version.formats ?? []).map((f) => f.type).join(", ") || "none";
      throw new LegislationApiError(
        `Section/schedule extraction requires XML, but it is not available for "${versionId}" (available: ${available}).`,
      );
    }
    const xml = await getDocument(xmlUrl);
    const root = parseLegislation(xml);

    if (args.section) {
      const result = findSection(root, args.section, exclude);
      if (!result) {
        throw new LegislationApiError(
          `Section ${args.section} not found in "${version.title ?? versionId}". Use list_sections to see available section numbers.`,
        );
      }
      return { ...meta, source_url: xmlUrl, source_format: "xml", ...result };
    } else {
      const result = findSchedule(root, args.schedule!, exclude);
      if (!result) {
        throw new LegislationApiError(
          `Schedule ${args.schedule} not found in "${version.title ?? versionId}". Use list_sections to see available schedules.`,
        );
      }
      return { ...meta, source_url: xmlUrl, source_format: "xml", ...result };
    }
  }

  // --- Whole-document mode ---
  const url = xmlUrl ?? htmlUrl;
  if (!url) {
    const available = (version.formats ?? []).map((f) => f.type).join(", ") || "none";
    throw new LegislationApiError(
      `No XML or HTML format available for version "${versionId}" (available: ${available}).`,
    );
  }

  const source = xmlUrl ? "xml" : "html";
  const raw = await getDocument(url);
  const text = source === "xml" ? xmlToText(raw, exclude) : htmlToText(raw);
  const { text: out, truncated } = truncate(text, args.max_chars ?? DEFAULT_MAX_CHARS);

  return { ...meta, source_url: url, source_format: source, truncated, text: out };
}
