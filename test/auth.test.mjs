// End-to-end tests of the HTTP server's login: OAuth discovery, client
// registration, the login page, PKCE, token refresh and revocation, lockouts,
// and the per-person daily cap. Runs the real Express app on a local port.
// No legislation API key is used.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LEGISLATION_REQUEST_TIMEOUT_MS = "300";
const { createHttpApp } = await import("../dist/http.js");
const { loadAuthSetup } = await import("../dist/auth/config.js");
const { hashPassword } = await import("../dist/auth/passwords.js");
const { getDocument } = await import("../dist/client.js");
const { requestContext } = await import("../dist/usage.js");

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PASSWORDS = { carolina: "correct horse battery", khai: "another long password" };
const dir = mkdtempSync(join(tmpdir(), "lnz-auth-"));
const statePath = join(dir, "auth-state.json");
let hashes;
let base;
let servers = [];

async function freePort() {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
}

/** Start the app with the given users (names from PASSWORDS) on a fixed port. */
async function start(port, users, extraEnv = {}) {
    for (const s of servers) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
    }
    const setup = loadAuthSetup({
        LEGISLATION_PUBLIC_URL: `http://localhost:${port}`,
        LEGISLATION_AUTH_USERS: users.map((u) => `${u}:${hashes[u]}`).join(","),
        LEGISLATION_AUTH_STATE: statePath,
        ...extraEnv,
    });
    const app = createHttpApp(setup);
    const server = await new Promise((r) => {
        const s = app.listen(port, "127.0.0.1", () => r(s));
    });
    servers = [server];
    return setup;
}

let port;
before(async () => {
    hashes = {
        carolina: await hashPassword(PASSWORDS.carolina),
        khai: await hashPassword(PASSWORDS.khai),
    };
    port = await freePort();
    base = `http://localhost:${port}`;
    await start(port, ["carolina", "khai"]);
});
after(async () => {
    for (const s of servers) {
        s.closeAllConnections();
        s.close();
    }
    rmSync(dir, { recursive: true, force: true });
});

const form = (fields) => new URLSearchParams(fields).toString();
const post = (path, body, headers = {}) =>
    fetch(base + path, { method: "POST", body, headers, redirect: "manual" });

async function register(redirectUris = [CALLBACK]) {
    return post("/register", JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris }), {
        "Content-Type": "application/json",
    });
}

function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

async function openLoginPage(client, challenge) {
    const url = new URL("/authorize", base);
    url.search = form({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "state-123",
        resource: `${base}/mcp`,
    });
    const res = await fetch(url, { redirect: "manual" });
    const html = await res.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
    return { res, html, requestId };
}

const login = (requestId, username, password) =>
    post("/login", form({ request_id: requestId, username, password }), {
        "Content-Type": "application/x-www-form-urlencoded",
    });

async function token(client, fields) {
    const res = await post(
        "/token",
        form({ client_id: client.client_id, client_secret: client.client_secret, ...fields }),
        { "Content-Type": "application/x-www-form-urlencoded" },
    );
    return { status: res.status, body: await res.json() };
}

/** Full login for a user; returns the client and tokens. */
async function signIn(user) {
    const client = await (await register()).json();
    const { verifier, challenge } = pkce();
    const { requestId } = await openLoginPage(client, challenge);
    const res = await login(requestId, user, PASSWORDS[user]);
    const code = new URL(res.headers.get("location")).searchParams.get("code");
    const { body } = await token(client, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: CALLBACK,
        resource: `${base}/mcp`,
    });
    return { client, tokens: body };
}

function mcp(accessToken, method, params = {}) {
    return post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    });
}

async function mcpResult(res) {
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text);
}

const initParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };

test("/mcp without a token is refused and points to the discovery document", async () => {
    const res = await mcp(undefined, "initialize", initParams);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.deepEqual(meta.authorization_servers, [`${base}/`]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.authorization_endpoint, `${base}/authorize`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("/healthz needs no token", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
});

test("clients may only register allow-listed redirect URIs", async () => {
    assert.equal((await register(["https://evil.example/callback"])).status, 400);
    assert.equal((await register()).status, 201);
});

test("the login page is served with strict headers and escapes the client name", async () => {
    const client = await (
        await post("/register", JSON.stringify({ client_name: "<script>x</script>", redirect_uris: [CALLBACK] }), {
            "Content-Type": "application/json",
        })
    ).json();
    const { res, html, requestId } = await openLoginPage(client, pkce().challenge);
    assert.equal(res.status, 200);
    assert.ok(requestId);
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&#60;script&#62;"));
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'self' https:\/\/claude\.ai/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a full login gives a token that works on /mcp", async () => {
    const client = await (await register()).json();
    const { verifier, challenge } = pkce();
    const { requestId } = await openLoginPage(client, challenge);

    const wrong = await login(requestId, "carolina", "not the password");
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Incorrect username or password/);
    const unknown = await login(requestId, "mallory", "whatever it is");
    assert.equal(unknown.status, 401);
    assert.match(await unknown.text(), /Incorrect username or password/);

    const ok = await login(requestId, "Carolina", PASSWORDS.carolina);
    assert.equal(ok.status, 302);
    const location = new URL(ok.headers.get("location"));
    assert.equal(location.origin + location.pathname, CALLBACK);
    assert.equal(location.searchParams.get("state"), "state-123");
    const code = location.searchParams.get("code");

    // The login page cannot be reused.
    assert.equal((await login(requestId, "carolina", PASSWORDS.carolina)).status, 400);

    // A wrong PKCE verifier is refused, and the code then still works once.
    const bad = await token(client, { grant_type: "authorization_code", code, code_verifier: pkce().verifier, redirect_uri: CALLBACK });
    assert.equal(bad.status, 400);
    const good = await token(client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK });
    assert.equal(good.status, 200);
    assert.equal(good.body.expires_in, 3600);
    const again = await token(client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK });
    assert.equal(again.status, 400, "codes are single use");

    const init = await mcp(good.body.access_token, "initialize", initParams);
    assert.equal(init.status, 200);
    assert.equal((await mcpResult(init)).result.serverInfo.name, "legislation-nz-mcp");
    const list = await mcpResult(await mcp(good.body.access_token, "tools/list"));
    assert.equal(list.result.tools.length, 8);

    // Only hashes of tokens reach the state file.
    const state = readFileSync(statePath, "utf8");
    assert.ok(!state.includes(good.body.access_token));
    assert.ok(!state.includes(good.body.refresh_token));
});

test("refresh tokens rotate, and reusing an old one ends the login", async () => {
    const { client, tokens } = await signIn("carolina");
    const first = await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refresh_token, tokens.refresh_token);
    assert.equal((await mcp(first.body.access_token, "tools/list")).status, 200);

    const reuse = await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    assert.equal(reuse.status, 400);
    assert.equal((await mcp(first.body.access_token, "tools/list")).status, 401, "the whole login is revoked");
    const after = await token(client, { grant_type: "refresh_token", refresh_token: first.body.refresh_token });
    assert.equal(after.status, 400);
});

test("removing a user from LEGISLATION_AUTH_USERS ends their logins", async () => {
    const khai = await signIn("khai");
    const carolina = await signIn("carolina");
    assert.equal((await mcp(khai.tokens.access_token, "tools/list")).status, 200);

    await start(port, ["carolina"]);
    assert.equal((await mcp(khai.tokens.access_token, "tools/list")).status, 401);
    assert.equal((await token(khai.client, { grant_type: "refresh_token", refresh_token: khai.tokens.refresh_token })).status, 400);
    assert.equal((await mcp(carolina.tokens.access_token, "tools/list")).status, 200, "other users are unaffected");
    await start(port, ["carolina", "khai"]);
});

test("changing a user's password ends their logins", async () => {
    const khai = await signIn("khai");
    const old = hashes.khai;
    hashes.khai = await hashPassword("a brand new long password");
    await start(port, ["carolina", "khai"]);
    assert.equal((await mcp(khai.tokens.access_token, "tools/list")).status, 401);
    hashes.khai = old;
    await start(port, ["carolina", "khai"]);
});

test("five wrong passwords lock the username, even against the right password", async () => {
    const client = await (await register()).json();
    const { requestId } = await openLoginPage(client, pkce().challenge);
    for (let i = 0; i < 5; i++) assert.equal((await login(requestId, "khai", "wrong password here")).status, 401);
    const locked = await login(requestId, "khai", PASSWORDS.khai);
    assert.equal(locked.status, 429);
    assert.match(await locked.text(), /Too many failed attempts/);
});

test("revoking a token through /revoke ends the login", async () => {
    const { client, tokens } = await signIn("carolina");
    const res = await post("/revoke", form({ client_id: client.client_id, client_secret: client.client_secret, token: tokens.refresh_token }), {
        "Content-Type": "application/x-www-form-urlencoded",
    });
    assert.equal(res.status, 200);
    assert.equal((await mcp(tokens.access_token, "tools/list")).status, 401);
});

test("each person's upstream requests are capped per day", async () => {
    await start(port, ["carolina", "khai"], { LEGISLATION_DAILY_CAP_PER_USER: "2" });
    const upstream = http.createServer((_req, res) => res.end("ok"));
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${upstream.address().port}/doc`;
    try {
        await requestContext.run({ user: "khai", upstream: 0 }, async () => {
            await getDocument(url);
            await getDocument(url);
            await assert.rejects(getDocument(url), /Daily limit reached: khai has made 2/);
        });
        // Someone else is unaffected.
        await requestContext.run({ user: "carolina", upstream: 0 }, () => getDocument(url));
        const usage = JSON.parse(readFileSync(statePath, "utf8")).usage;
        const today = Object.values(usage).at(-1);
        assert.equal(today.khai, 2);
    } finally {
        upstream.close();
        await start(port, ["carolina", "khai"]);
    }
});

test("the server refuses to start without a public URL or users", () => {
    assert.throws(() => loadAuthSetup({ LEGISLATION_AUTH_USERS: `carolina:${hashes.carolina}` }), /LEGISLATION_PUBLIC_URL is not set/);
    assert.throws(() => loadAuthSetup({ LEGISLATION_PUBLIC_URL: "https://x.example" }), /LEGISLATION_AUTH_USERS is empty/);
    assert.throws(
        () => loadAuthSetup({ LEGISLATION_PUBLIC_URL: "https://x.example", LEGISLATION_AUTH_USERS: "carolina:hunter2" }),
        /not a password hash/,
    );
    assert.throws(
        () => loadAuthSetup({ LEGISLATION_PUBLIC_URL: "http://x.example", LEGISLATION_AUTH_USERS: `carolina:${hashes.carolina}` }),
        /must use https/,
    );
    assert.equal(loadAuthSetup({ LEGISLATION_AUTH: "off" }).mode, "off");
});
