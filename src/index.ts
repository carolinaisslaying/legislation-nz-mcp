#!/usr/bin/env node
/**
 * legislation-nz-mcp (stdio entry)
 *
 * A local MCP server exposing the New Zealand legislation.govt.nz developer API
 * as tools an LLM can call: search legislation, list point-in-time versions,
 * inspect a version's available formats, and read a document's text.
 *
 * Transport: stdio (for Claude Desktop / Claude Code). For remote/HTTP use
 * (e.g. behind the jlg-mcp gateway) see http.ts.
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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  if (!process.env.LEGISLATION_NZ_API_KEY) {
    // Warn on stderr (stdout is reserved for the MCP protocol) but still start,
    // so tools can return a clean error rather than the process refusing to run.
    console.error(
      "[legislation-nz-mcp] Warning: LEGISLATION_NZ_API_KEY is not set. Tool calls will fail until it is provided.",
    );
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[legislation-nz-mcp] Server running on stdio.");
}

main().catch((err) => {
  console.error("[legislation-nz-mcp] Fatal error:", err);
  process.exit(1);
});
