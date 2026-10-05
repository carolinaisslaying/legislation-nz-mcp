/**
 * Settings for the HTTP server's login, read from the environment.
 *
 *   LEGISLATION_PUBLIC_URL      the address people reach the server at, e.g.
 *                               https://legislation.example.nz (the OAuth issuer)
 *   LEGISLATION_AUTH_USERS      user:hash pairs, comma-separated; make a hash with
 *                               `node dist/auth/cli.js hash-password <user>`
 *   LEGISLATION_AUTH_STATE      state file (default ./data/auth-state.json)
 *   LEGISLATION_AUTH_REDIRECT_ALLOWLIST
 *                               redirect URIs an OAuth client may register, comma-
 *                               separated (default: claude.ai's callbacks)
 *   LEGISLATION_DAILY_CAP_PER_USER
 *                               upstream API requests each user may make per NZ day
 *                               (default 4000; 0 turns the cap off)
 *   LEGISLATION_AUTH=off        no login at all, for local testing; the server
 *                               then listens on 127.0.0.1 only
 */

import { isPasswordHash } from "./passwords.js";

export const DEFAULT_REDIRECT_ALLOWLIST = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

export interface AuthConfig {
  publicUrl: URL;
  /** The MCP endpoint, which is also the resource tokens are issued for. */
  mcpUrl: URL;
  users: Map<string, string>;
  statePath: string;
  redirectAllowlist: string[];
  dailyCapPerUser: number;
}

export type AuthSetup = { mode: "on"; config: AuthConfig } | { mode: "off"; dailyCapPerUser: number };

export class ConfigError extends Error {}

const USERNAME = /^[a-z0-9_-]{1,32}$/;

export function isValidUsername(name: string): boolean {
  return USERNAME.test(name);
}

function parseUsers(raw: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const colon = entry.indexOf(":");
    const name = colon > 0 ? entry.slice(0, colon) : "";
    const hash = entry.slice(colon + 1);
    if (!isValidUsername(name)) {
      throw new ConfigError(`LEGISLATION_AUTH_USERS: "${name || entry.slice(0, 12)}" is not a valid username (a-z, 0-9, _ and -).`);
    }
    if (!isPasswordHash(hash)) {
      throw new ConfigError(
        `LEGISLATION_AUTH_USERS: the entry for "${name}" is not a password hash. Make one with: node dist/auth/cli.js hash-password ${name}`,
      );
    }
    if (users.has(name)) throw new ConfigError(`LEGISLATION_AUTH_USERS: "${name}" appears twice.`);
    users.set(name, hash);
  }
  return users;
}

function parseCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 4000;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0) throw new ConfigError("LEGISLATION_DAILY_CAP_PER_USER must be a whole number (0 for no cap).");
  return cap;
}

export function loadAuthSetup(env: NodeJS.ProcessEnv = process.env): AuthSetup {
  const dailyCapPerUser = parseCap(env.LEGISLATION_DAILY_CAP_PER_USER);
  if (env.LEGISLATION_AUTH === "off") return { mode: "off", dailyCapPerUser };
  if (env.LEGISLATION_AUTH && env.LEGISLATION_AUTH !== "on") {
    throw new ConfigError('LEGISLATION_AUTH must be "on" (the default) or "off".');
  }

  const rawUrl = env.LEGISLATION_PUBLIC_URL?.trim();
  if (!rawUrl) {
    throw new ConfigError(
      "LEGISLATION_PUBLIC_URL is not set. Set it to the address you reach this server at (e.g. https://legislation.example.nz), " +
        "or set LEGISLATION_AUTH=off to run locally without a login.",
    );
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl);
  } catch {
    throw new ConfigError(`LEGISLATION_PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const local = publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
  if (publicUrl.protocol !== "https:" && !local) throw new ConfigError("LEGISLATION_PUBLIC_URL must use https.");
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new ConfigError("LEGISLATION_PUBLIC_URL must be just the origin, e.g. https://legislation.example.nz");
  }

  const users = parseUsers(env.LEGISLATION_AUTH_USERS ?? "");
  if (!users.size) {
    throw new ConfigError(
      "LEGISLATION_AUTH_USERS is empty, so nobody could log in. Add user:hash entries " +
        "(node dist/auth/cli.js hash-password <user>), or set LEGISLATION_AUTH=off to run locally without a login.",
    );
  }

  const redirectAllowlist = env.LEGISLATION_AUTH_REDIRECT_ALLOWLIST?.trim()
    ? env.LEGISLATION_AUTH_REDIRECT_ALLOWLIST.split(",").map((u) => u.trim()).filter(Boolean)
    : DEFAULT_REDIRECT_ALLOWLIST;

  return {
    mode: "on",
    config: {
      publicUrl,
      mcpUrl: new URL("/mcp", publicUrl),
      users,
      statePath: env.LEGISLATION_AUTH_STATE?.trim() || "data/auth-state.json",
      redirectAllowlist,
      dailyCapPerUser,
    },
  };
}
