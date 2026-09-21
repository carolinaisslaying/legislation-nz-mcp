import { z } from "zod";
import { getFeed, feedUrl } from "../client.js";
import { parseFeed } from "../feed.js";

const FEED_PATH = "/api/rss/search/";

export const searchRssInputSchema = {
  search_term: z
    .string()
    .optional()
    .describe(
      "Search phrase. ElasticSearch simple query syntax; stemming is on by default " +
        "(wrap a phrase in double quotes to disable it). Omit it to browse by the filters alone.",
    ),
  search_field: z
    .enum(["title", "content", "fulltext"])
    .optional()
    .describe(
      "Search titles only (the feed's default) or the full document text. " +
        "\"content\" and \"fulltext\" both mean full text: the documentation says fulltext, " +
        "but the live feed only honours content, so either is sent as content.",
    ),
  legislation_type: z
    .enum(["act", "amendment_paper", "bill", "secondary_legislation"])
    .optional()
    .describe("Restrict to a category of legislation."),
  legislation_status: z
    .enum(["in_force", "not_in_force", "no_value"])
    .optional()
    .describe("Restrict by whether the legislation is currently in force."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Return at most this many entries. The feed itself returns up to 100 entries and ignores paging parameters.",
    ),
};

const schema = z.object(searchRssInputSchema);

export async function searchLegislationRss(args: z.infer<typeof schema>) {
  const params = {
    search_term: args.search_term,
    // The documented "fulltext" value returns nothing on the live feed; "content" works.
    search_field: args.search_field === "fulltext" ? "content" : args.search_field,
    legislation_type: args.legislation_type,
    legislation_status: args.legislation_status,
  };
  const feed = parseFeed(await getFeed(FEED_PATH, params));
  const entries = args.limit ? feed.entries.slice(0, args.limit) : feed.entries;
  return {
    feed_url: feedUrl(FEED_PATH, params),
    feed_title: feed.title,
    feed_updated: feed.updated,
    entries_in_feed: feed.entries.length,
    count: entries.length,
    entries,
  };
}
