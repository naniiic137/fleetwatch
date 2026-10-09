import assert from "node:assert/strict";
import { test } from "node:test";

import { checkAll, checkTarget } from "../src/check.js";
import { makeClock, scriptedFetch } from "./helpers.js";

const T = { name: "a", url: "https://a.example", expectStatus: 200 };

test("a 200 response is up and timed", async () => {
  const clock = makeClock(1_000_000);
  const fetchImpl = scriptedFetch({}, clock, 250);
  const r = await checkTarget(T, { fetchImpl, now: clock });
  assert.deepEqual(r, { name: "a", url: T.url, t: 1_000_000, ok: true, code: 200, ms: 250, err: null });
  assert.equal(fetchImpl.calls[0].init.redirect, "manual");
  assert.match(fetchImpl.calls[0].init.headers["user-agent"], /fleetwatch-worker/);
});

test("an unexpected status is down", async () => {
  const clock = makeClock(0);
  const r = await checkTarget(T, { fetchImpl: scriptedFetch({ [T.url]: 503 }, clock), now: clock });
  assert.equal(r.ok, false);
  assert.equal(r.code, 503);
  assert.equal(r.err, "expected 200, got 503");
});

test("a custom expected status is honoured", async () => {
  const clock = makeClock(0);
  const target = { ...T, expectStatus: 301 };
  const r = await checkTarget(target, { fetchImpl: scriptedFetch({ [T.url]: 301 }, clock), now: clock });
  assert.equal(r.ok, true);
});

test("timeouts and network errors are down with code 0", async () => {
  const clock = makeClock(0);
  const timeout = await checkTarget(T, { fetchImpl: scriptedFetch({ [T.url]: "timeout" }, clock), now: clock, timeoutMs: 5000 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, 0);
  assert.equal(timeout.err, "timeout after 5000 ms");
  const broken = await checkTarget(T, { fetchImpl: scriptedFetch({ [T.url]: "error" }, clock), now: clock });
  assert.match(broken.err, /^fetch failed: Network connection lost/);
});

test("checkAll checks every target", async () => {
  const clock = makeClock(0);
  const targets = [T, { name: "b", url: "https://b.example" }];
  const results = await checkAll(targets, { fetchImpl: scriptedFetch({ "https://b.example": 500 }, clock), now: clock });
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [["a", true], ["b", false]]);
});
