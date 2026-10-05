/**
 * Server factory for legislation-nz-mcp.
 *
 * Builds a fully-configured McpServer with all tools registered, independent of
 * transport. `index.ts` wraps this in stdio (for Claude Desktop / Claude Code);
 * `http.ts` wraps it in streamable HTTP (for a remote gateway).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { LegislationApiError, lastRateLimit } from "./client.js";
import { searchLegislation, searchInputSchema } from "./tools/search.js";
import { listVersions, versionsInputSchema } from "./tools/versions.js";
import { getVersionDetails, versionDetailsInputSchema } from "./tools/versionDetails.js";
import { getLegislationText, getTextInputSchema } from "./tools/getText.js";
import { listSections, listSectionsInputSchema } from "./tools/listSections.js";
import { searchLegislationRss, searchRssInputSchema } from "./tools/searchRss.js";
import { listVersionsRss, versionsRssInputSchema } from "./tools/versionsRss.js";
import { getRateLimitStatusTool, rateLimitInputSchema } from "./tools/rateLimit.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wrap a tool handler so any error (API or otherwise) is returned as MCP
 * tool-error content rather than crashing the server. Successful object
 * results gain a `rate_limit` field with the quota headers from the request
 * the tool just made.
 */
function toolResult<T>(
  handler: (args: T) => Promise<unknown>,
  opts: { attachRateLimit?: boolean } = {},
) {
  const attach = opts.attachRateLimit ?? true;
  return async (args: T) => {
    try {
      const data = await handler(args);
      const payload =
        attach && isPlainObject(data) ? { ...data, rate_limit: lastRateLimit() } : data;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err) {
      const message =
        err instanceof LegislationApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

/** Every tool only reads public legislation data from the PCO's API. */
const READ_ONLY_TOOL = { readOnlyHint: true, openWorldHint: true };

/** Construct a new McpServer instance with every tool registered. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "legislation-nz-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "search_legislation",
    {
      description:
        "Search New Zealand legislation (acts, bills, secondary legislation, amendment papers) by title or full-text content, or browse by omitting search_term and using filters alone. " +
        "Returns matching works with their newest matching version id, website URLs, publisher, and available formats. " +
        "latest_matching_version_is_latest is false when a content search matched only an older version (e.g. text since repealed). " +
        "Type-specific filters (act_*, bill_*, instrument_*) imply legislation_type; mixing types is rejected. " +
        "Ids containing ~ are ephemeral and carry ephemeral: true. Use this first to find a work_id or version_id.",
      inputSchema: searchInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(searchLegislation),
  );

  server.registerTool(
    "list_versions",
    {
      description:
        "List all point-in-time versions of a work (identified by work_id), newest first by default, each with its website URL; the newest carries is_latest_version: true. " +
        "Work-level metadata (title, type, status, agencies) is reported once at the top rather than repeated per version. " +
        "Fetches every page automatically (the API serves at most 100 per page); pass page (and optionally per_page) to fetch a single page instead. " +
        "Use this to find a version_id for a specific date.",
      inputSchema: versionsInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(listVersions),
  );

  server.registerTool(
    "get_version_details",
    {
      description:
        "Get metadata for a single version, including the list of available document formats (html, pdf, xml) and their URLs.",
      inputSchema: versionDetailsInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(getVersionDetails),
  );

  server.registerTool(
    "get_legislation_text",
    {
      description:
        "Retrieve the text of a piece of legislation. Provide a version_id or work_id. " +
        "Without section/schedule params, returns the whole document as cleaned plain text. " +
        "With a section param (e.g. \"22\" or \"25A\"), returns just that section with its Part/subpart context. " +
        "With a schedule param (e.g. \"1\"), returns just that schedule. Use list_sections to discover numbers first. " +
        "Only the document's own provisions are matched, never text quoted inside an amending provision. " +
        "A non-current provision carries status (e.g. \"repealed\", \"struck_out\"). Where a number is shared (a repealed section and a later one with the same number), " +
        "the current one is returned with other_matches and a warning; always pass the warning on to the user. " +
        "With format:\"pdf\", returns the official PDF download URL instead of text; format:\"pdf_original_scan\" returns the scan of the original printed Act (pre-2008 as-enacted versions only).",
      inputSchema: getTextInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(getLegislationText),
  );

  server.registerTool(
    "list_sections",
    {
      description:
        "List the structure of a legislation document: Parts, subparts, section numbers and headings, and schedules. " +
        "Entries that are not current carry status (e.g. \"repealed\", \"struck_out\"); text quoted inside amending provisions is not listed. " +
        "Use this before get_legislation_text to find the right section or schedule number.",
      inputSchema: listSectionsInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(listSections),
  );

  server.registerTool(
    "search_legislation_rss",
    {
      description:
        "Search New Zealand legislation through the legacy Atom feed (the documented /api/rss/search/ endpoint) by title or full text, with type and status filters; omit search_term to browse by filters alone. " +
        "Returns up to 100 feed entries (title, website URL, derived work_id/version_id, timestamps) plus a subscribable feed URL. " +
        "Needs LEGISLATION_NZ_RSS_API_KEY, a separate RSS-only key. For on-demand queries prefer search_legislation, which is a superset.",
      inputSchema: searchRssInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(searchLegislationRss),
  );

  server.registerTool(
    "list_versions_rss",
    {
      description:
        "Read the legacy Atom feed of a work's versions (the documented /api/rss/works/{work_id}/versions/ endpoint). " +
        "Returns one entry per version with its website URL, derived version_id, and publication timestamp, plus a subscribable feed URL for change monitoring. " +
        "Needs LEGISLATION_NZ_RSS_API_KEY, a separate RSS-only key. For on-demand queries prefer list_versions.",
      inputSchema: versionsRssInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(listVersionsRss),
  );

  server.registerTool(
    "get_rate_limit_status",
    {
      description:
        "Report remaining daily quota from the X-RateLimit-* response headers: the JSON API key (10,000 requests/day) and the feed key (1,500 requests/day). " +
        "Quotas reset at midnight NZ time. By default spends one minimal API request to get fresh numbers; refresh:\"none\" returns the values last observed. " +
        "The separate burst limit of 2,000 requests per 5 minutes per IP is not reported in headers.",
      inputSchema: rateLimitInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    toolResult(getRateLimitStatusTool, { attachRateLimit: false }),
  );

  return server;
}
