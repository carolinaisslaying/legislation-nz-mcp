/**
 * Persistent login state: registered OAuth clients, logins (grants), hashes of
 * the tokens issued for them, and each user's daily request count.
 *
 * One small JSON file, rewritten atomically (temporary file, then rename) on
 * every change. Only hashes of tokens are stored, so the file does not grant
 * access by itself. Single process only: nothing else may write the file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface Grant {
  user: string;
  /** passwordFingerprint of the user's password when they logged in. */
  fingerprint: string;
  clientId: string;
  resource: string;
  createdAt: number;
  revokedAt?: number;
}

export interface TokenRecord {
  grantId: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

interface StateFile {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  grants: Record<string, Grant>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
  /** Hashes of refresh tokens already exchanged; reuse means a token was stolen. */
  usedRefreshTokens: Record<string, TokenRecord>;
  /** NZ date -> user -> upstream requests made that day. */
  usage: Record<string, Record<string, number>>;
}

const EMPTY: StateFile = {
  version: 1,
  clients: {},
  grants: {},
  accessTokens: {},
  refreshTokens: {},
  usedRefreshTokens: {},
  usage: {},
};

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export class AuthStore {
  private state: StateFile;

  constructor(private readonly path: string) {
    this.state = existsSync(path)
      ? { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>) }
      : structuredClone(EMPTY);
    mkdirSync(dirname(path), { recursive: true });
    this.prune();
    this.save();
  }

  private save(): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Drop expired tokens, revoked grants and old usage counts. */
  prune(now = Date.now() / 1000): void {
    for (const table of [this.state.accessTokens, this.state.refreshTokens, this.state.usedRefreshTokens]) {
      for (const [hash, record] of Object.entries(table)) if (record.expiresAt < now) delete table[hash];
    }
    const live = new Set(Object.values(this.state.refreshTokens).map((r) => r.grantId));
    for (const [id, grant] of Object.entries(this.state.grants)) {
      // A grant ends when its refresh token lapses; keep revoked ones a day for reuse detection.
      if (!live.has(id) && (grant.revokedAt ?? now) < now - 86_400) delete this.state.grants[id];
      if (!live.has(id) && !grant.revokedAt && grant.createdAt < now - 31 * 86_400) delete this.state.grants[id];
    }
    const days = Object.keys(this.state.usage).sort();
    for (const day of days.slice(0, -7)) delete this.state.usage[day];
  }

  // --- clients ---

  getClient(id: string): OAuthClientInformationFull | undefined {
    return this.state.clients[id];
  }

  addClient(client: OAuthClientInformationFull, maxClients = 100): void {
    this.state.clients[client.client_id] = client;
    // Registration is open by design (claude.ai registers itself), so keep the
    // table bounded: drop the oldest clients that no current login uses.
    const ids = Object.keys(this.state.clients);
    if (ids.length > maxClients) {
      const inUse = new Set(Object.values(this.state.grants).filter((g) => !g.revokedAt).map((g) => g.clientId));
      const idle = ids
        .filter((id) => !inUse.has(id) && id !== client.client_id)
        .sort((a, b) => (this.state.clients[a].client_id_issued_at ?? 0) - (this.state.clients[b].client_id_issued_at ?? 0));
      for (const id of idle.slice(0, ids.length - maxClients)) delete this.state.clients[id];
    }
    this.save();
  }

  // --- grants and tokens ---

  addGrant(id: string, grant: Grant): void {
    this.state.grants[id] = grant;
    this.save();
  }

  getGrant(id: string): Grant | undefined {
    return this.state.grants[id];
  }

  revokeGrant(id: string, now = Date.now() / 1000): void {
    const grant = this.state.grants[id];
    if (!grant || grant.revokedAt) return;
    grant.revokedAt = now;
    for (const table of [this.state.accessTokens, this.state.refreshTokens]) {
      for (const [hash, record] of Object.entries(table)) if (record.grantId === id) delete table[hash];
    }
    this.save();
  }

  /** Revoke every login of a user, e.g. when they are removed. */
  revokeUser(user: string): number {
    let count = 0;
    for (const [id, grant] of Object.entries(this.state.grants)) {
      if (grant.user === user && !grant.revokedAt) {
        this.revokeGrant(id);
        count++;
      }
    }
    return count;
  }

  addTokens(access: [string, TokenRecord], refresh: [string, TokenRecord]): void {
    this.state.accessTokens[tokenHash(access[0])] = access[1];
    this.state.refreshTokens[tokenHash(refresh[0])] = refresh[1];
    this.save();
  }

  getAccessToken(token: string): TokenRecord | undefined {
    return this.state.accessTokens[tokenHash(token)];
  }

  getRefreshToken(token: string): TokenRecord | undefined {
    return this.state.refreshTokens[tokenHash(token)];
  }

  getUsedRefreshToken(token: string): TokenRecord | undefined {
    return this.state.usedRefreshTokens[tokenHash(token)];
  }

  /** Move a refresh token to the used list once it has been exchanged. */
  retireRefreshToken(token: string): void {
    const hash = tokenHash(token);
    const record = this.state.refreshTokens[hash];
    if (!record) return;
    delete this.state.refreshTokens[hash];
    this.state.usedRefreshTokens[hash] = record;
    this.save();
  }

  removeAccessToken(token: string): void {
    delete this.state.accessTokens[tokenHash(token)];
    this.save();
  }

  // --- daily usage ---

  usage(day: string, user: string): number {
    return this.state.usage[day]?.[user] ?? 0;
  }

  addUsage(day: string, user: string): number {
    const today = (this.state.usage[day] ??= {});
    today[user] = (today[user] ?? 0) + 1;
    if (Object.keys(this.state.usage).length > 8) this.prune();
    this.save();
    return today[user];
  }
}
