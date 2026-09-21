import { z } from "zod";
import { getJson, LegislationApiError } from "../client.js";
import type { Work } from "../types.js";
import {
  unwrapResults,
  totalOf,
  dateFromVersionId,
  workUrl,
  versionUrl,
  isEphemeral,
  type Paginated,
} from "../util.js";

export const searchInputSchema = {
  search_term: z
    .string()
    .optional()
    .describe(
      "Search phrase. Supports ElasticSearch simple query syntax (e.g. \"privacy\", \"data +breach\"); " +
        "stemming is on by default, wrap a phrase in double quotes to disable it. " +
        "Omit it to browse: the filters alone (or no filters at all) list every matching work.",
    ),
  search_field: z
    .enum(["title", "content"])
    .optional()
    .describe("Search titles only, or full document content. Defaults to the API default (title)."),
  legislation_type: z
    .enum(["act", "amendment_paper", "bill", "secondary_legislation"])
    .optional()
    .describe(
      "Restrict to a category of legislation. Inferred automatically when an act_*, bill_*, or instrument_* filter is given.",
    ),
  legislation_status: z
    .enum(["in_force", "not_in_force", "no_value"])
    .optional()
    .describe("Restrict by whether the legislation is currently in force."),
  act_type: z
    .enum(["public", "private", "imperial", "local", "provincial"])
    .optional()
    .describe("Restrict acts to a subtype (e.g. public vs local/private). Acts only; implies legislation_type \"act\"."),
  act_classification: z
    .enum(["principal", "amendment"])
    .optional()
    .describe("Restrict acts to principal (foundational) or amendment acts. Acts only; implies legislation_type \"act\"."),
  act_status: z
    .enum(["in_force", "not_in_force", "repealed"])
    .optional()
    .describe("Restrict acts by their current legislative standing. Acts only; implies legislation_type \"act\"."),
  publisher: z
    .enum(["Agency", "Parliamentary Counsel Office"])
    .optional()
    .describe("Restrict by the publishing body."),
  bill_type: z
    .enum(["government", "local", "member", "private"])
    .optional()
    .describe("Restrict bills to a type. Bills only; implies legislation_type \"bill\"."),
  bill_status: z
    .enum(["current", "enacted", "terminated"])
    .optional()
    .describe("Restrict bills by their current status. Bills only; implies legislation_type \"bill\"."),
  instrument_type_group: z
    .enum([
      "regulations",
      "order",
      "rules",
      "code",
      "bylaws",
      "determination",
      "exemption",
      "notice",
      "instrument",
      "other_type",
    ])
    .optional()
    .describe(
      "Restrict secondary legislation to an instrument type group. Secondary legislation only; implies legislation_type \"secondary_legislation\".",
    ),
  instrument_status: z
    .enum(["expired", "in_force", "not_yet_in_force", "revoked", "superseded"])
    .optional()
    .describe(
      "Restrict secondary legislation by its current status. Secondary legislation only; implies legislation_type \"secondary_legislation\".",
    ),
  instrument_classification: z
    .enum(["principal", "amendment"])
    .optional()
    .describe(
      "Restrict secondary legislation to principal or amendment instruments. Secondary legislation only; implies legislation_type \"secondary_legislation\".",
    ),
  administering_agencies: z
    .string()
    .optional()
    .describe(
      "Filter by administering agency. Must be the agency's full name exactly as listed at " +
        "https://www.legislation.govt.nz/browse/agencies (e.g. \"Ministry of Justice\").",
    ),
  sort_by: z
    .enum(["title_asc", "title_desc", "year_asc", "year_desc", "most_recently_updated"])
    .optional()
    .describe("Result ordering."),
  page: z.number().int().min(1).optional().describe("Page number (default 1)."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Results per page (default 20, max 100)."),
};

const schema = z.object(searchInputSchema);
type SearchArgs = z.infer<typeof schema>;
type LegislationType = NonNullable<SearchArgs["legislation_type"]>;

/** Type-specific filters and the legislation_type each one applies to (per the API docs). */
const TYPE_SPECIFIC_FILTERS: Record<string, LegislationType> = {
  act_type: "act",
  act_classification: "act",
  act_status: "act",
  bill_type: "bill",
  bill_status: "bill",
  instrument_type_group: "secondary_legislation",
  instrument_status: "secondary_legislation",
  instrument_classification: "secondary_legislation",
};

/**
 * Resolve the effective legislation_type. The API says act_*, bill_* and
 * instrument_* filters should only be sent with their matching type, so infer
 * it when absent and reject contradictory combinations.
 */
function resolveLegislationType(args: SearchArgs): SearchArgs["legislation_type"] {
  const implied = new Map<LegislationType, string[]>();
  for (const [filter, type] of Object.entries(TYPE_SPECIFIC_FILTERS)) {
    if (args[filter as keyof SearchArgs] !== undefined) {
      implied.set(type, [...(implied.get(type) ?? []), filter]);
    }
  }
  if (implied.size > 1) {
    const parts = [...implied].map(([type, names]) => `${names.join(", ")} (${type})`);
    throw new LegislationApiError(
      `Filters for different legislation types cannot be combined: ${parts.join("; ")}. Use one type's filters at a time.`,
    );
  }
  const entry = implied.entries().next().value;
  if (!entry) return args.legislation_type;
  const [type, names] = entry;
  if (args.legislation_type && args.legislation_type !== type) {
    throw new LegislationApiError(
      `${names.join(", ")} ${names.length === 1 ? "applies" : "apply"} only to legislation_type "${type}", ` +
        `but legislation_type is "${args.legislation_type}".`,
    );
  }
  return type;
}

/** Trim a Work down to the fields worth returning to the model. */
function summarizeWork(w: Work) {
  const v = w.latest_matching_version;
  return {
    work_id: w.work_id,
    // Title is carried on the version, not the work.
    title: v?.title,
    url: workUrl(w.work_id),
    ephemeral: isEphemeral(w.work_id),
    legislation_type: w.legislation_type,
    legislation_status: w.legislation_status,
    publisher: w.publisher,
    administering_agencies: w.administering_agencies,
    latest_matching_version_id: v?.version_id,
    latest_matching_version_date: dateFromVersionId(v?.version_id),
    latest_matching_version_url: versionUrl(v?.version_id),
    // False when the search matched only an older version (e.g. text since repealed).
    latest_matching_version_is_latest: v?.is_latest_version,
    formats: v ? (v.formats ?? []).map((f) => f.type).filter(Boolean) : undefined,
    act_type: w.act_type,
    act_status: w.act_status,
    act_classification: w.act_classification,
    bill_type: w.bill_type,
    bill_status: w.bill_status,
    instrument_type_group: w.instrument_type_group,
    instrument_status: w.instrument_status,
    instrument_classification: w.instrument_classification,
  };
}

export async function searchLegislation(args: SearchArgs) {
  const legislationType = resolveLegislationType(args);
  const data = await getJson<Paginated<Work>>("/v0/works/", {
    search_term: args.search_term,
    search_field: args.search_field,
    legislation_type: legislationType,
    legislation_status: args.legislation_status,
    act_type: args.act_type,
    act_classification: args.act_classification,
    act_status: args.act_status,
    publisher: args.publisher,
    bill_type: args.bill_type,
    bill_status: args.bill_status,
    instrument_type_group: args.instrument_type_group,
    instrument_status: args.instrument_status,
    instrument_classification: args.instrument_classification,
    administering_agencies: args.administering_agencies,
    sort_by: args.sort_by,
    page: args.page,
    per_page: args.per_page,
  });

  const works = unwrapResults(data);
  return {
    total: totalOf(data),
    count: works.length,
    results: works.map(summarizeWork),
  };
}
