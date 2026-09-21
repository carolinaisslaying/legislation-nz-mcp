import { z } from "zod";
import { getFeed, feedUrl, LegislationApiError } from "../client.js";
import { parseFeed } from "../feed.js";

export const versionsRssInputSchema = {
  work_id: z
    .string()
    .describe("The work_id whose version feed to read (e.g. \"act_public_2020_31\")."),
};

const schema = z.object(versionsRssInputSchema);

export async function listVersionsRss(args: z.infer<typeof schema>) {
  const path = `/api/rss/works/${encodeURIComponent(args.work_id)}/versions/`;
  const feed = parseFeed(await getFeed(path));
  // The feed answers HTTP 200 with <id>not_found</id> for an unknown work.
  if (feed.feed_id === "not_found") {
    throw new LegislationApiError(`No feed found for work_id "${args.work_id}".`, 404);
  }
  return {
    work_id: args.work_id,
    feed_url: feedUrl(path),
    feed_title: feed.title,
    feed_updated: feed.updated,
    count: feed.entries.length,
    entries: feed.entries,
  };
}
