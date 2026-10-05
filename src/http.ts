#!/usr/bin/env node
/**
 * legislation-nz-mcp (streamable HTTP entry)
 *
 * Serves the same tools as index.ts over HTTP, for claude.ai custom connectors.
 * Requests to /mcp need an OAuth access token issued by this server's own
 * login (see src/auth/): each user signs in with their own password the first
 * time they add the connector. LEGISLATION_AUTH=off drops the login for local
 * testing and then listens on 127.0.0.1 only.
 *
 * Stateless MCP: a fresh McpServer + transport per request, so there is no
 * session state to leak between requests. Every tool call is logged (who,
 * which tool, which document) and each person's upstream API requests are
 * capped per NZ day.
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(projectRoot, ".env"), quiet: true });

import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createServer, type ToolCallRecord } from "./server.js";
import { loadAuthSetup, ConfigError, type AuthSetup } from "./auth/config.js";
import { LoginProvider, clientIp } from "./auth/provider.js";
import { installDailyCap, memoryUsageCounter, requestContext } from "./usage.js";
import { logEvent } from "./log.js";

const PORT = Number(process.env.LEGISLATION_HTTP_PORT ?? 8091);
const MCP_PATH = "/mcp";

/** Arguments worth logging: which document and where in it, never search text. */
const LOGGED_ARGS = ["version_id", "work_id", "section", "schedule", "as_at", "format", "legislation_type", "page"];

function logToolCall(call: ToolCallRecord): void {
  const ctx = requestContext.getStore();
  const args = (call.args ?? {}) as Record<string, unknown>;
  const document: Record<string, unknown> = {};
  for (const key of LOGGED_ARGS) if (args[key] !== undefined) document[key] = args[key];
  logEvent("tool_call", {
    user: ctx?.user,
    tool: call.tool,
    ...document,
    ok: call.ok,
    error: call.error,
    upstream_requests: ctx?.upstream,
    ms: call.ms,
  });
}

function jsonError(res: Response, status: number, code: number, message: string) {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Build the Express app. Exported for tests. */
export function createHttpApp(setup: AuthSetup) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  let mcpAuth: express.RequestHandler[] = [];
  if (setup.mode === "on") {
    const { config } = setup;
    const provider = new LoginProvider(config);
    installDailyCap(config.dailyCapPerUser, provider.store);
    // The SDK's own rate limits on these endpoints, keyed by the real visitor IP.
    const rateLimit = { keyGenerator: (req: Request) => clientIp(req), validate: false };
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: config.publicUrl,
        resourceServerUrl: config.mcpUrl,
        resourceName: "NZ Legislation MCP",
        authorizationOptions: { rateLimit },
        clientRegistrationOptions: { rateLimit },
        tokenOptions: { rateLimit },
        revocationOptions: { rateLimit },
      }),
    );
    app.post("/login", express.urlencoded({ extended: false, limit: "8kb" }), (req, res, next) => {
      provider.handleLogin(req, res).catch(next);
    });
    mcpAuth = [
      requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
        expectedResource: config.mcpUrl,
      }),
    ];
  } else {
    installDailyCap(setup.dailyCapPerUser, memoryUsageCounter());
  }

  app.all(MCP_PATH, ...mcpAuth, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    // Streamable HTTP defines GET (server->client SSE) and DELETE (end session) too.
    // In stateless mode there is nothing to stream or tear down, so decline those.
    if (req.method !== "POST") {
      jsonError(res, 405, -32000, "Method not allowed (stateless server).");
      return;
    }
    const user = typeof req.auth?.extra?.user === "string" ? req.auth.extra.user : "local";
    await requestContext.run({ user, upstream: 0 }, async () => {
      const server = createServer({ onToolCall: logToolCall });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logEvent("request_error", { user, error: err instanceof Error ? err.message : String(err) });
        jsonError(res, 500, -32603, "Internal server error.");
      }
    });
  });

  app.use((_req, res) => jsonError(res, 404, -32601, "Not found."));
  // Malformed JSON bodies and other errors: a clean JSON-RPC error, never a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      jsonError(res, status, -32700, "Bad request.");
      return;
    }
    logEvent("request_error", { error: err instanceof Error ? err.message : String(err) });
    jsonError(res, 500, -32603, "Internal server error.");
  });
  return app;
}

function main(): void {
  let setup: AuthSetup;
  try {
    setup = loadAuthSetup();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[legislation-nz-mcp] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (setup.mode === "on" && !isAbsolute(setup.config.statePath)) {
    setup.config.statePath = resolve(projectRoot, setup.config.statePath);
  }
  const host = setup.mode === "off" ? "127.0.0.1" : (process.env.LEGISLATION_HTTP_HOST ?? "127.0.0.1");

  if (!process.env.LEGISLATION_NZ_API_KEY) {
    console.error(
      "[legislation-nz-mcp] Warning: LEGISLATION_NZ_API_KEY is not set. Tool calls will fail until it is provided.",
    );
  }
  if (setup.mode === "off") {
    console.error("[legislation-nz-mcp] LEGISLATION_AUTH=off: no login. Listening on 127.0.0.1 only.");
  }
  const app = createHttpApp(setup);
  app.listen(PORT, host, () => {
    logEvent("started", {
      url: `http://${host}:${PORT}${MCP_PATH}`,
      auth: setup.mode,
      public_url: setup.mode === "on" ? setup.config.publicUrl.origin : undefined,
      users: setup.mode === "on" ? [...setup.config.users.keys()] : undefined,
      daily_cap_per_user: setup.mode === "on" ? setup.config.dailyCapPerUser : setup.dailyCapPerUser,
    });
  });
}

// Run only when started directly (tests import createHttpApp).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
