#!/usr/bin/env node
/**
 * legislation-nz-mcp (streamable HTTP entry)
 *
 * Serves the same tools as index.ts over HTTP so the server can run as its own
 * localhost service behind a reverse proxy or gateway. It has NO authentication of its
 * own by design: it binds to 127.0.0.1 and the gateway is the only thing that
 * talks to it. Do not expose this port to a public interface.
 *
 * Stateless mode: a fresh McpServer + transport is created per request, so there
 * is no session state to leak between the gateway's connections. Built on the
 * node:http core module (no web framework dependency).
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(projectRoot, ".env"), quiet: true });

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const HOST = process.env.LEGISLATION_HTTP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LEGISLATION_HTTP_PORT ?? 8091);
const MCP_PATH = "/mcp";

/** Collect a request body and JSON-parse it (empty body -> undefined). */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function jsonError(res: http.ServerResponse, status: number, code: number, message: string) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

const httpServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== MCP_PATH) {
    jsonError(res, 404, -32601, "Not found.");
    return;
  }
  // Streamable HTTP defines GET (server->client SSE) and DELETE (end session) too.
  // In stateless mode there is nothing to stream or tear down, so decline those.
  if (req.method !== "POST") {
    jsonError(res, 405, -32000, "Method not allowed (stateless server).");
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    const body = await readJsonBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[legislation-nz-mcp] request error:", err);
    jsonError(res, 500, -32603, "Internal server error.");
  }
});

httpServer.listen(PORT, HOST, () => {
  if (!process.env.LEGISLATION_NZ_API_KEY) {
    console.error(
      "[legislation-nz-mcp] Warning: LEGISLATION_NZ_API_KEY is not set. Tool calls will fail until it is provided.",
    );
  }
  console.error(`[legislation-nz-mcp] Streamable HTTP server on http://${HOST}:${PORT}${MCP_PATH}`);
});
