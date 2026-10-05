// Choosing a version by date: as_at, and "latest" meaning the newest version
// dated on or before today in New Zealand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickVersionAsAt, nzDate } from "../dist/tools/resolve.js";

const ids = [
    "act_public_1961_43_en_2026-08-08",
    "act_public_1961_43_en_2025-11-27B",
    "act_public_1961_43_en_2025-11-27",
    "act_public_1961_43_en_2025-11-27C",
    "act_public_1961_43_en_2015-07-03",
    "act_public_1961_43_en_1961-11-01",
];

test("picks the newest version dated on or before the date", () => {
    assert.equal(pickVersionAsAt(ids, "2020-01-01"), "act_public_1961_43_en_2015-07-03");
    assert.equal(pickVersionAsAt(ids, "2015-07-03"), "act_public_1961_43_en_2015-07-03");
    assert.equal(pickVersionAsAt(ids, "2015-07-02"), "act_public_1961_43_en_1961-11-01");
});

test("of several versions on one date, picks the last suffix", () => {
    assert.equal(pickVersionAsAt(ids, "2025-12-31"), "act_public_1961_43_en_2025-11-27C");
});

test("returns undefined before the earliest version", () => {
    assert.equal(pickVersionAsAt(ids, "1960-01-01"), undefined);
});

test("ignores ids without a date", () => {
    assert.equal(pickVersionAsAt(["act_public_1961_43_en_~x", ...ids], "2030-01-01"), "act_public_1961_43_en_2026-08-08");
});

test("today is the New Zealand calendar date", () => {
    // 11:30 UTC on 4 October is 00:30 NZDT on 5 October.
    assert.equal(nzDate(new Date("2026-10-04T11:30:00Z")), "2026-10-05");
    assert.equal(nzDate(new Date("2026-06-01T11:59:00Z")), "2026-06-01");
});
