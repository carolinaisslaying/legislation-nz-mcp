import { z } from "zod";
import { getJson, getFeed, getRateLimitStatus } from "../client.js";

export const rateLimitInputSchema = {
  refresh: z
    .enum(["api", "rss", "both", "none"])
    .optional()
    .describe(
      "Which quota to re-check with one minimal request each (default \"api\"). " +
        "\"none\" returns the values last observed by earlier tool calls without spending a request.",
    ),
};

const schema = z.object(rateLimitInputSchema);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function getRateLimitStatusTool(args: z.infer<typeof schema>) {
  const refresh = args.refresh ?? "api";
  const refreshed: string[] = [];
  const refresh_errors: Record<string, string> = {};

  if (refresh === "api" || refresh === "both") {
    try {
      await getJson("/v0/works/", { search_term: "act", per_page: 1 });
      refreshed.push("api");
    } catch (err) {
      refresh_errors.api = errorText(err);
    }
  }
  if (refresh === "rss" || refresh === "both") {
    try {
      // A term with no matches keeps the response tiny.
      await getFeed("/api/rss/search/", { search_term: "zzzzzzzz" });
      refreshed.push("rss");
    } catch (err) {
      refresh_errors.rss = errorText(err);
    }
  }

  const status = getRateLimitStatus();
  return {
    refreshed,
    ...(Object.keys(refresh_errors).length ? { refresh_errors } : {}),
    api: status.api ?? null,
    rss: status.rss ?? null,
  };
}
