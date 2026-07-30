import { z } from "zod";
import { getJson } from "../client.js";
import type { Work } from "../types.js";
import { unwrapResults, totalOf, dateFromVersionId, type Paginated } from "../util.js";

export const searchInputSchema = {
  search_term: z
    .string()
    .describe("Search phrase. Supports ElasticSearch simple query syntax (e.g. \"privacy\", \"data +breach\")."),
  search_field: z
    .enum(["title", "content"])
    .optional()
    .describe("Search titles only, or full document content. Defaults to the API default (title)."),
  legislation_type: z
    .enum(["act", "amendment_paper", "bill", "secondary_legislation"])
    .optional()
    .describe("Restrict to a category of legislation."),
  legislation_status: z
    .enum(["in_force", "not_in_force", "no_value"])
    .optional()
    .describe("Restrict by whether the legislation is currently in force."),
  act_type: z
    .enum(["public", "private", "imperial", "local", "provincial"])
    .optional()
    .describe("Restrict acts to a subtype (e.g. public vs local/private)."),
  act_classification: z
    .enum(["principal", "amendment"])
    .optional()
    .describe("Restrict acts to principal (foundational) or amendment acts."),
  act_status: z
    .enum(["in_force", "not_in_force", "repealed"])
    .optional()
    .describe("Restrict acts by their current legislative standing."),
  publisher: z
    .enum(["Agency", "Parliamentary Counsel Office"])
    .optional()
    .describe("Restrict by the publishing body."),
  bill_type: z
    .enum(["government", "local", "member", "private"])
    .optional()
    .describe("Restrict bills to a type."),
  bill_status: z
    .enum(["current", "enacted", "terminated"])
    .optional()
    .describe("Restrict bills by their current status."),
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
    .describe("Restrict secondary legislation to an instrument type group."),
  instrument_status: z
    .enum(["expired", "in_force", "not_yet_in_force", "revoked", "superseded"])
    .optional()
    .describe("Restrict secondary legislation by its current status."),
  instrument_classification: z
    .enum(["principal", "amendment"])
    .optional()
    .describe("Restrict secondary legislation to principal or amendment instruments."),
  administering_agencies: z
    .string()
    .optional()
    .describe("Filter by administering agency name."),
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

/** Trim a Work down to the fields worth returning to the model. */
function summarizeWork(w: Work) {
  const v = w.latest_matching_version;
  return {
    work_id: w.work_id,
    // Title is carried on the version, not the work.
    title: v?.title,
    legislation_type: w.legislation_type,
    legislation_status: w.legislation_status,
    administering_agencies: w.administering_agencies,
    latest_matching_version_id: v?.version_id,
    latest_version_date: dateFromVersionId(v?.version_id),
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

export async function searchLegislation(args: z.infer<typeof schema>) {
  const data = await getJson<Paginated<Work>>("/v0/works/", {
    search_term: args.search_term,
    search_field: args.search_field,
    legislation_type: args.legislation_type,
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
