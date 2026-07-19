/**
 * Server factory for legislation-nz-mcp.
 *
 * Builds a fully-configured McpServer with all tools registered, independent of
 * transport. `index.ts` wraps this in stdio (for Claude Desktop / Claude Code);
 * `http.ts` wraps it in streamable HTTP (for the jlg-mcp remote gateway).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { LegislationApiError } from "./client.js";
import { searchLegislation, searchInputSchema } from "./tools/search.js";
import { listVersions, versionsInputSchema } from "./tools/versions.js";
import { getVersionDetails, versionDetailsInputSchema } from "./tools/versionDetails.js";
import { getLegislationText, getTextInputSchema } from "./tools/getText.js";
import { listSections, listSectionsInputSchema } from "./tools/listSections.js";

/**
 * Wrap a tool handler so any error (API or otherwise) is returned as MCP
 * tool-error content rather than crashing the server.
 */
function toolResult<T>(handler: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const data = await handler(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
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

/** Construct a new McpServer instance with every tool registered. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "legislation-nz-mcp",
    version: "0.1.0",
  });

  server.tool(
    "search_legislation",
    "Search New Zealand legislation (acts, bills, secondary legislation, amendment papers) by title or full-text content. Returns matching works with their newest matching version id. Use this first to find a work_id or version_id.",
    searchInputSchema,
    toolResult(searchLegislation),
  );

  server.tool(
    "list_versions",
    "List all point-in-time versions of a work (identified by work_id), newest first by default. Use this to find a version_id for a specific date.",
    versionsInputSchema,
    toolResult(listVersions),
  );

  server.tool(
    "get_version_details",
    "Get metadata for a single version, including the list of available document formats (html, pdf, xml) and their URLs.",
    versionDetailsInputSchema,
    toolResult(getVersionDetails),
  );

  server.tool(
    "get_legislation_text",
    "Retrieve the text of a piece of legislation. Provide a version_id or work_id. " +
      "Without section/schedule params, returns the whole document as cleaned plain text. " +
      "With a section param (e.g. \"22\" or \"25A\"), returns just that section with its Part/subpart context. " +
      "With a schedule param (e.g. \"1\"), returns just that schedule. Use list_sections to discover numbers first. " +
      "With format:\"pdf\", returns the official PDF download URL instead of text.",
    getTextInputSchema,
    toolResult(getLegislationText),
  );

  server.tool(
    "list_sections",
    "List the structure of a legislation document: Parts, subparts, section numbers and headings, and schedules. " +
      "Use this before get_legislation_text to find the right section or schedule number.",
    listSectionsInputSchema,
    toolResult(listSections),
  );

  return server;
}
