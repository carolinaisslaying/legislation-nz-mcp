/**
 * OAuth 2.1 authorisation server for the HTTP endpoint, plugged into the
 * SDK's mcpAuthRouter (which supplies discovery metadata, client
 * registration, PKCE checks and the token endpoint).
 *
 * The login page is this server's own: each user has a password whose scrypt
 * hash is in LEGISLATION_AUTH_USERS. Tokens are random and opaque; only their
 * hashes are stored. Access tokens last an hour; refresh tokens last 30 days
 * idle and are rotated on every use, and reusing an old one ends that login.
 * Removing a user, or changing their password, ends their logins.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthConfig } from "./config.js";
import { AuthStore } from "./store.js";
import { Lockout } from "./lockout.js";
import { passwordFingerprint, unknownUserHash, verifyPassword } from "./passwords.js";
import { renderLoginPage, renderMessagePage, setPageHeaders } from "./loginPage.js";
import { logEvent } from "../log.js";

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_IDLE_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_REQUEST_MS = 10 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
/** Wrong passwords allowed per username, and per client IP, within 15 minutes. */
const USER_FAILURE_LIMIT = 5;
const IP_FAILURE_LIMIT = 20;

interface PendingLogin {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  user: string;
  fingerprint: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  expiresAt: number;
}

const PRIVATE_ADDRESS = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

/**
 * The visitor's IP for lockouts and rate limits. Behind a Cloudflare Tunnel
 * the socket peer is cloudflared, so CF-Connecting-IP is used, but only when
 * the request reached us from a private address (i.e. through the tunnel).
 */
export function clientIp(req: Request): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded && PRIVATE_ADDRESS.test(peer)) return forwarded.trim();
  return peer;
}

const randomToken = (): string => randomBytes(32).toString("base64url");

export class LoginProvider implements OAuthServerProvider {
  readonly store: AuthStore;
  private pending = new Map<string, PendingLogin>();
  private codes = new Map<string, IssuedCode>();
  private userLockout = new Lockout(USER_FAILURE_LIMIT);
  private ipLockout = new Lockout(IP_FAILURE_LIMIT);

  constructor(private readonly config: AuthConfig) {
    this.store = new AuthStore(config.statePath);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.getClient(id),
      registerClient: (client) => {
        const disallowed = client.redirect_uris.filter((uri) => !this.config.redirectAllowlist.includes(String(uri)));
        if (disallowed.length) {
          logEvent("auth.register_refused", { client_name: client.client_name, redirect_uris: disallowed });
          throw new InvalidClientMetadataError(
            `Redirect URI not allowed by this server: ${disallowed.join(", ")}. ` +
              "Add it to LEGISLATION_AUTH_REDIRECT_ALLOWLIST if it is a client you use.",
          );
        }
        const full = client as OAuthClientInformationFull;
        this.store.addClient(full);
        logEvent("auth.client_registered", { client_id: full.client_id, client_name: full.client_name });
        return full;
      },
    };
  }

  private checkResource(resource: URL | undefined): string {
    const ours = this.config.mcpUrl.href;
    if (resource && resource.href.replace(/\/$/, "") !== ours.replace(/\/$/, "")) {
      throw new InvalidTargetError(`This server only issues tokens for ${ours}.`);
    }
    return ours;
  }

  /** Start a login: show the login page (the SDK has already checked the client and redirect URI). */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    this.sweep();
    const requestId = randomToken();
    this.pending.set(requestId, { clientId: client.client_id, params, expiresAt: Date.now() + LOGIN_REQUEST_MS });
    setPageHeaders(res, params.redirectUri);
    res
      .status(200)
      .type("html")
      .send(renderLoginPage({ requestId, clientName: client.client_name ?? "An app", redirectUri: params.redirectUri }));
  }

  /** POST /login: check the password and, if right, send the browser back with a code. */
  async handleLogin(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const ip = clientIp(req);
    this.sweep();

    const pending = this.pending.get(requestId);
    if (!pending) {
      setPageHeaders(res);
      res
        .status(400)
        .type("html")
        .send(renderMessagePage("Sign-in expired", "This sign-in page has expired or was already used. Start again from Claude."));
      return;
    }
    const client = this.store.getClient(pending.clientId);
    const redirectUri = pending.params.redirectUri;
    const page = (status: number, error: string) => {
      setPageHeaders(res, redirectUri);
      res
        .status(status)
        .type("html")
        .send(renderLoginPage({ requestId, clientName: client?.client_name ?? "An app", redirectUri, username, error }));
    };

    const userKey = `user:${username}`;
    const ipKey = `ip:${ip}`;
    const locked = Math.max(this.userLockout.lockedFor(userKey), this.ipLockout.lockedFor(ipKey));
    if (locked > 0) {
      logEvent("auth.login_locked", { user: username, ip });
      page(429, `Too many failed attempts. Try again in ${Math.ceil(locked / 60_000)} minutes.`);
      return;
    }

    const hash = this.config.users.get(username);
    // Always run scrypt, so an unknown username takes as long as a wrong password.
    const ok = (await verifyPassword(password, hash ?? (await unknownUserHash()))) && hash !== undefined;
    if (!ok || !client) {
      const userLocked = this.userLockout.fail(userKey);
      const ipLocked = this.ipLockout.fail(ipKey);
      const lockedNow = userLocked || ipLocked;
      logEvent(lockedNow ? "auth.login_lockout" : "auth.login_failed", { user: username, ip });
      page(401, "Incorrect username or password.");
      return;
    }

    this.userLockout.clear(userKey);
    this.pending.delete(requestId);
    const code = randomToken();
    this.codes.set(code, {
      clientId: pending.clientId,
      user: username,
      fingerprint: passwordFingerprint(hash),
      codeChallenge: pending.params.codeChallenge,
      redirectUri,
      resource: this.checkResource(pending.params.resource),
      expiresAt: Date.now() + CODE_MS,
    });
    logEvent("auth.login", { user: username, ip, client_id: pending.clientId, client_name: client.client_name });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state) target.searchParams.set("state", pending.params.state);
    setPageHeaders(res, redirectUri);
    res.redirect(302, target.href);
  }

  private sweep(now = Date.now()): void {
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
    for (const [code, c] of this.codes) if (c.expiresAt < now) this.codes.delete(code);
  }

  private liveCode(client: OAuthClientInformationFull, code: string): IssuedCode {
    this.sweep();
    const issued = this.codes.get(code);
    if (!issued || issued.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorisation code.");
    return issued;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.liveCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const issued = this.liveCode(client, code);
    this.codes.delete(code); // single use
    if (redirectUri !== undefined && redirectUri !== issued.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the one used to log in.");
    }
    this.checkResource(resource);
    if (!this.userIsCurrent(issued.user, issued.fingerprint)) throw new InvalidGrantError("This user can no longer log in.");
    const grantId = randomUUID();
    this.store.addGrant(grantId, {
      user: issued.user,
      fingerprint: issued.fingerprint,
      clientId: client.client_id,
      resource: issued.resource,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return this.issueTokens(grantId);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const record = this.store.getRefreshToken(refreshToken);
    if (!record) {
      const used = this.store.getUsedRefreshToken(refreshToken);
      if (used) {
        // An exchanged refresh token came back: someone else holds a copy.
        const grant = this.store.getGrant(used.grantId);
        this.store.revokeGrant(used.grantId);
        logEvent("auth.refresh_reuse", { user: grant?.user, client_id: client.client_id, action: "login revoked" });
      }
      throw new InvalidGrantError("Invalid refresh token.");
    }
    const grant = this.store.getGrant(record.grantId);
    if (!grant || grant.revokedAt || grant.clientId !== client.client_id || record.expiresAt < Date.now() / 1000) {
      throw new InvalidGrantError("Invalid refresh token.");
    }
    if (!this.userIsCurrent(grant.user, grant.fingerprint)) {
      this.store.revokeGrant(record.grantId);
      throw new InvalidGrantError("This user can no longer log in.");
    }
    this.store.retireRefreshToken(refreshToken);
    return this.issueTokens(record.grantId);
  }

  private issueTokens(grantId: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const access = randomToken();
    const refresh = randomToken();
    this.store.addTokens(
      [access, { grantId, expiresAt: now + ACCESS_TOKEN_SECONDS }],
      [refresh, { grantId, expiresAt: now + REFRESH_TOKEN_IDLE_SECONDS }],
    );
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh };
  }

  private userIsCurrent(user: string, fingerprint: string): boolean {
    const hash = this.config.users.get(user);
    return hash !== undefined && passwordFingerprint(hash) === fingerprint;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(token);
    const grant = record && this.store.getGrant(record.grantId);
    if (!record || !grant || grant.revokedAt || record.expiresAt < Date.now() / 1000) {
      throw new InvalidTokenError("Invalid or expired access token.");
    }
    if (!this.userIsCurrent(grant.user, grant.fingerprint)) {
      this.store.revokeGrant(record.grantId);
      throw new InvalidTokenError("This user can no longer log in.");
    }
    return {
      token,
      clientId: grant.clientId,
      scopes: [],
      expiresAt: record.expiresAt,
      resource: new URL(grant.resource),
      extra: { user: grant.user },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const record = this.store.getAccessToken(request.token) ?? this.store.getRefreshToken(request.token);
    const grant = record && this.store.getGrant(record.grantId);
    if (record && grant?.clientId === client.client_id) {
      this.store.revokeGrant(record.grantId);
      logEvent("auth.revoked", { user: grant.user, client_id: client.client_id });
    }
  }
}
