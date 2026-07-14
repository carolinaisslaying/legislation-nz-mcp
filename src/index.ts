#!/usr/bin/env node
/**
 * legislation-nz-mcp
 *
 * A local MCP server exposing the New Zealand legislation.govt.nz developer API
 * as tools an LLM can call: search legislation, list point-in-time versions,
 * inspect a version's available formats, and read a document's text.
 *
 * Transport: stdio (for Claude Desktop / Claude Code).
 *
 * The LEGISLATION_NZ_API_KEY is read from the environment. For convenience it
 * can instead be placed in a `.env` file in the project root — loaded below
 * before anything reads the key. An env var already set by the MCP client's
 * `env` block takes precedence (dotenv does not override existing values).
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve `.env` relative to this compiled file (dist/index.js), not the
// current working directory — Claude Code may launch us from anywhere.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `quiet: true` suppresses dotenv's startup banner — critical here because
// stdout is reserved for the MCP JSON-RPC stream and any stray output corrupts it.
loadDotenv({ path: resolve(projectRoot, ".env"), quiet: true });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { LegislationApiError } from "./client.js";
import { searchLegislation, searchInputSchema } from "./tools/search.js";
import { listVersions, versionsInputSchema } from "./tools/versions.js";
import { getVersionDetails, versionDetailsInputSchema } from "./tools/versionDetails.js";
import { getLegislationText, getTextInputSchema } from "./tools/getText.js";
import { listSections, listSectionsInputSchema } from "./tools/listSections.js";

const server = new McpServer({
  name: "legislation-nz-mcp",
  version: "0.1.0",
});

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
  "With a schedule param (e.g. \"1\"), returns just that schedule. Use list_sections to discover numbers first.",
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

async function main() {
  if (!process.env.LEGISLATION_NZ_API_KEY) {
    // Warn on stderr (stdout is reserved for the MCP protocol) but still start,
    // so tools can return a clean error rather than the process refusing to run.
    console.error(
      "[legislation-nz-mcp] Warning: LEGISLATION_NZ_API_KEY is not set. Tool calls will fail until it is provided.",
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[legislation-nz-mcp] Server running on stdio.");
}

main().catch((err) => {
  console.error("[legislation-nz-mcp] Fatal error:", err);
  process.exit(1);
});
