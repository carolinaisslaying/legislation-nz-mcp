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
  };
}

export async function searchLegislation(args: z.infer<typeof schema>) {
  const data = await getJson<Paginated<Work>>("/v0/works/", {
    search_term: args.search_term,
    search_field: args.search_field,
    legislation_type: args.legislation_type,
    legislation_status: args.legislation_status,
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
