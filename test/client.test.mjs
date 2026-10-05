// Upstream timeouts, the overall deadline, and the per-request hook, against a
// local server. getDocument is used with a non-legislation host, so no API key
// is needed or sent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.LEGISLATION_REQUEST_TIMEOUT_MS = "300";
process.env.LEGISLATION_REQUEST_DEADLINE_MS = "2500";
const { getDocument, LegislationApiError, setUpstreamRequestHook } = await import("../dist/client.js");

const hits = new Map();
let base;
const server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    if (req.url === "/once" && hits.get(req.url) > 1) return res.end("ok after retry");
    if (req.url === "/ok") return res.end("ok");
    // Anything else hangs.
});

before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
    server.closeAllConnections();
    server.close();
});

test("a request that hangs once succeeds on retry", async () => {
    assert.equal(await getDocument(`${base}/once`), "ok after retry");
    assert.equal(hits.get("/once"), 2);
});

test("a dead upstream fails with a readable error within the overall deadline", async () => {
    const started = Date.now();
    await assert.rejects(getDocument(`${base}/hang`), (err) => {
        assert.ok(err instanceof LegislationApiError);
        assert.match(err.message, /^Request timed out/);
        assert.doesNotMatch(err.message, /127\.0\.0\.1|\/hang/);
        return true;
    });
    // 300 ms attempt, 1 s backoff, 300 ms attempt; the next 2 s backoff would
    // pass the 2.5 s deadline, so it stops there.
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2500, `took ${elapsed} ms`);
    assert.equal(hits.get("/hang"), 2);
});

test("the upstream request hook runs before every attempt and can refuse it", async () => {
    const seen = [];
    setUpstreamRequestHook((scope) => seen.push(scope));
    await getDocument(`${base}/ok`);
    assert.deepEqual(seen, ["api"]);

    setUpstreamRequestHook(() => {
        throw new LegislationApiError("Daily cap reached.");
    });
    const before = hits.get("/ok");
    await assert.rejects(getDocument(`${base}/ok`), /Daily cap reached/);
    assert.equal(hits.get("/ok"), before, "no request was sent");
    setUpstreamRequestHook(undefined);
});
