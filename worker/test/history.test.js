import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyResults,
  avgLatency24h,
  emptyState,
  HOUR_BUCKETS,
  normalizeState,
  summarize,
  uptime24h,
  uptime7d,
} from "../src/history.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 1, 0, 0, 0);
const TARGETS = [
  { name: "a", url: "https://a.example" },
  { name: "b", url: "https://b.example" },
];

function result(name, t, ok, ms = 100) {
  return { name, url: `https://${name}.example`, t, ok, code: ok ? 200 : 503, ms, err: ok ? null : "expected 200, got 503" };
}

/** Simulate cron runs every 5 minutes; `isUp(name, t)` decides each outcome. */
function simulate(runs, isUp, state = emptyState()) {
  let t = START;
  for (let i = 0; i < runs; i++) {
    t = START + i * 5 * MIN;
    const results = TARGETS.map((x) => result(x.name, t, isUp(x.name, t)));
    state = applyResults(state, results, TARGETS, t);
  }
  return { state, t };
}

test("normalizeState rejects junk and old versions", () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState("x"), emptyState());
  assert.deepEqual(normalizeState({ v: 0, targets: {} }), emptyState());
  const ok = { v: 1, updated: 5, runs: 1, targets: {} };
  assert.equal(normalizeState(ok), ok);
});

test("applyResults is pure and records last, raw and hourly buckets", () => {
  const before = emptyState();
  const after = applyResults(before, [result("a", START, true, 80), result("b", START, false, 300)], TARGETS, START);
  assert.deepEqual(before, emptyState());
  assert.equal(after.runs, 1);
  assert.equal(after.updated, START);
  assert.deepEqual(after.targets.a.raw, [[START / MIN, 80, 1]]);
  assert.deepEqual(after.targets.a.hours, [[START / HOUR, 1, 1, 80]]);
  assert.deepEqual(after.targets.b.hours, [[START / HOUR, 1, 0, 0]]);
  assert.equal(after.targets.b.last.ok, false);
  assert.equal(after.targets.b.last.code, 503);
});

test("raw keeps 24 h, hours keep 7 days, at a 5-minute cadence", () => {
  const { state } = simulate((8 * DAY) / (5 * MIN), () => true);
  assert.equal(state.targets.a.raw.length, 288);
  assert.equal(state.targets.a.hours.length, HOUR_BUCKETS);
  assert.ok(state.targets.a.hours.every((h) => h[1] === 12));
  // ~ size of the single KV value for 10 targets (5x what 2 targets use)
  const bytes = JSON.stringify(state).length * 5;
  assert.ok(bytes < 200_000, `state too large: ${bytes} bytes`);
});

test("uptime over 24 h and 7 days", () => {
  // "b" is down for the first 12 hours of a 2-day run.
  const { state, t } = simulate((2 * DAY) / (5 * MIN), (name, at) => name === "a" || at >= START + 12 * HOUR);
  assert.equal(uptime24h(state.targets.a, t), 1);
  assert.equal(uptime24h(state.targets.b, t), 1);
  assert.equal(uptime7d(state.targets.a, t), 1);
  assert.equal(uptime7d(state.targets.b, t), 0.75);
  assert.equal(avgLatency24h(state.targets.b, t), 100);
});

test("uptime ignores data that fell out of the window and is null without data", () => {
  const { state, t } = simulate(10, () => false);
  assert.equal(uptime24h(state.targets.a, t), 0);
  assert.equal(uptime24h(state.targets.a, t + 2 * DAY), null);
  assert.equal(uptime7d(state.targets.a, t + 8 * DAY), null);
  assert.equal(uptime24h(undefined, t), null);
  assert.equal(avgLatency24h(state.targets.a, t), null);
});

test("removed targets are dropped and new targets start empty", () => {
  const first = applyResults(emptyState(), [result("a", START, true)], [TARGETS[0]], START);
  const next = applyResults(first, [result("b", START + 5 * MIN, true)], [TARGETS[1]], START + 5 * MIN);
  assert.deepEqual(Object.keys(next.targets), ["b"]);
  assert.equal(next.targets.b.raw.length, 1);
});

test("summarize returns one row per target in config order", () => {
  const { state, t } = simulate(3, (name) => name === "a");
  const rows = summarize(state, TARGETS, t);
  assert.deepEqual(rows.map((r) => [r.name, r.up, r.statusCode]), [["a", true, 200], ["b", false, 503]]);
  const none = summarize(emptyState(), TARGETS, t);
  assert.equal(none[0].up, null);
  assert.equal(none[0].uptime24h, null);
  assert.deepEqual(none[0].points, []);
});
