import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyResults,
  avgLatency24h,
  emptyState,
  HOUR_BUCKETS,
  normalizeState,
  STATE_VERSION,
  summarize,
  unpackRows,
  uptime24h,
  uptime7d,
} from "../src/history.js";
import { v1State } from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STEP = 10 * MIN; // the cron's interval
const START = Date.UTC(2026, 9, 1, 0, 0, 0);
const TARGETS = [
  { name: "a", url: "https://a.example" },
  { name: "b", url: "https://b.example" },
];

function result(name, t, ok, ms = 100) {
  return { name, url: `https://${name}.example`, t, ok, code: ok ? 200 : 503, ms, err: ok ? null : "expected 200, got 503" };
}

/** Simulate cron runs every 10 minutes; `isUp(name, t)` decides each outcome. */
function simulate(runs, isUp, state = emptyState()) {
  let t = START;
  for (let i = 0; i < runs; i++) {
    t = START + i * STEP;
    const results = TARGETS.map((x) => result(x.name, t, isUp(x.name, t)));
    state = applyResults(state, results, TARGETS, t);
  }
  return { state, t };
}

test("normalizeState rejects junk and old versions", () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState("x"), emptyState());
  assert.deepEqual(normalizeState({ v: 0, targets: {} }), emptyState());
  assert.deepEqual(normalizeState({ v: 3, targets: {} }), emptyState());
  assert.equal(STATE_VERSION, 2);
  const ok = { v: 2, updated: 5, runs: 1, targets: {} };
  assert.equal(normalizeState(ok), ok);
});

test("applyResults is pure and records last, raw and hourly buckets", () => {
  const before = emptyState();
  const after = applyResults(before, [result("a", START, true, 80), result("b", START, false, 300)], TARGETS, START);
  assert.deepEqual(before, emptyState());
  assert.equal(after.runs, 1);
  assert.equal(after.updated, START);
  assert.equal(after.targets.a.raw, `${START / MIN},80,1`);
  assert.equal(after.targets.a.hours, `${START / HOUR},1,1,80`);
  assert.equal(after.targets.b.hours, `${START / HOUR},1,0,0`);
  assert.equal(after.targets.b.last.ok, false);
  assert.equal(after.targets.b.last.code, 503);
});

test("raw keeps 24 h, hours keep 7 days, at a 10-minute cadence", () => {
  const { state } = simulate((8 * DAY) / STEP, () => true);
  assert.equal(unpackRows(state.targets.a.raw).length, 144);
  const hours = unpackRows(state.targets.a.hours);
  assert.equal(hours.length, HOUR_BUCKETS);
  assert.ok(hours.every((h) => h[1] === 6));
  // ~ size of the single KV value for 22 targets (11x what 2 targets use)
  const bytes = JSON.stringify(state).length * 11;
  assert.ok(bytes < 130_000, `state too large: ${bytes} bytes`);
});

test("uptime over 24 h and 7 days", () => {
  // "b" is down for the first 12 hours of a 2-day run.
  const { state, t } = simulate((2 * DAY) / STEP, (name, at) => name === "a" || at >= START + 12 * HOUR);
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
  const next = applyResults(first, [result("b", START + STEP, true)], [TARGETS[1]], START + STEP);
  assert.deepEqual(Object.keys(next.targets), ["b"]);
  assert.equal(unpackRows(next.targets.b.raw).length, 1);
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

test("rows are one string, oldest first, with no url and no arrays", () => {
  const first = applyResults(emptyState(), [result("a", START, true, 80)], [TARGETS[0]], START);
  const t = START + STEP;
  const next = applyResults(first, [result("a", t, false, 0)], [TARGETS[0]], t);
  assert.deepEqual(Object.keys(next.targets.a), ["last", "raw", "hours"]);
  assert.equal(next.targets.a.raw, `${START / MIN},80,1;${t / MIN},0,0`);
  assert.equal(next.targets.a.hours, `${START / HOUR},2,1,80`);
  assert.deepEqual(unpackRows(next.targets.a.raw), [[START / MIN, 80, 1], [t / MIN, 0, 0]]);
  assert.equal(first.targets.a.raw, `${START / MIN},80,1`, "the old state is not changed");
});

test("a new hour starts a new bucket and the oldest rows are cut from the front", () => {
  const nowMinute = START / MIN;
  const nowHour = START / HOUR;
  const state = {
    v: 2,
    updated: 1,
    runs: 1,
    targets: {
      a: {
        last: null,
        // One at the very edge of each window (out), one just inside.
        raw: `${nowMinute - 1440},1,1;${nowMinute - 1439},2,1`,
        hours: `${nowHour - 168},1,1,1;${nowHour - 167},1,1,2`,
      },
    },
  };
  const next = applyResults(state, [result("a", START, true, 3)], [TARGETS[0]], START);
  assert.equal(next.targets.a.raw, `${nowMinute - 1439},2,1;${nowMinute},3,1`);
  assert.equal(next.targets.a.hours, `${nowHour - 167},1,1,2;${nowHour},1,1,3`);
  // With no new result and everything too old, the strings end up empty.
  const later = applyResults(next, [], [TARGETS[0]], START + 9 * DAY);
  assert.equal(later.targets.a.raw, "");
  assert.equal(later.targets.a.hours, "");
  assert.equal(uptime24h(later.targets.a, START + 9 * DAY), null);
});

test("damaged rows count as no data and never break a run", () => {
  assert.deepEqual(unpackRows(undefined), []);
  assert.deepEqual(unpackRows(""), []);
  assert.deepEqual(unpackRows("abc;1,2"), []);
  assert.deepEqual(unpackRows(5), []);
  const state = { v: 2, updated: 1, runs: 1, targets: { a: { last: null, raw: 7, hours: ["x"] }, b: { last: null, raw: "junk", hours: "junk" } } };
  const rows = summarize(state, TARGETS, START);
  assert.deepEqual(rows[1].points, []);
  assert.equal(rows[1].uptime7d, null);
  const next = applyResults(state, [result("a", START, true, 5), result("b", START, true, 5)], TARGETS, START);
  assert.equal(next.targets.a.raw, `${START / MIN},5,1`);
  assert.equal(next.targets.a.hours, `${START / HOUR},1,1,5`);
  assert.equal(next.targets.b.raw, `${START / MIN},5,1`);
  assert.equal(next.targets.b.hours, `${START / HOUR},1,1,5`);
});

test("a v1 state converts with every sample kept", () => {
  const v1 = v1State(TARGETS, START);
  const state = normalizeState(v1);
  assert.equal(state.v, STATE_VERSION);
  assert.equal(state.updated, v1.updated);
  assert.equal(state.runs, v1.runs);
  assert.equal(v1.targets.a.raw.length, 288);
  assert.equal(v1.targets.a.hours.length, HOUR_BUCKETS);
  for (const { name } of TARGETS) {
    assert.deepEqual(unpackRows(state.targets[name].raw), v1.targets[name].raw);
    assert.deepEqual(unpackRows(state.targets[name].hours), v1.targets[name].hours);
    assert.deepEqual(state.targets[name].last, v1.targets[name].last);
    assert.deepEqual(Object.keys(state.targets[name]), ["last", "raw", "hours"]);
  }
  assert.equal(v1.v, 1, "the value read from KV is not changed");
});

test("a v1 site with no checks yet and an error message both convert", () => {
  const entry = {
    url: "https://a.example",
    last: { t: START, ok: false, code: 0, ms: 10000, err: "fetch failed: a, b; c" },
    raw: [[START / MIN, 10000, 0]],
    hours: [[START / HOUR, 1, 0, 0]],
  };
  const state = normalizeState({ v: 1, updated: START, runs: 1, targets: { a: entry, b: { url: "https://b.example", last: null, raw: [], hours: [] } } });
  assert.equal(state.targets.a.last.err, "fetch failed: a, b; c");
  assert.equal(state.targets.a.raw, `${START / MIN},10000,0`);
  assert.deepEqual(state.targets.b, { last: null, raw: "", hours: "" });
});

test("a v1 state with anything unexpected starts fresh", () => {
  const good = () => ({ url: "u", last: null, raw: [[1, 2, 1]], hours: [[1, 1, 1, 2]] });
  const bad = [
    { ...good(), raw: "1,2,1" },
    { ...good(), raw: undefined },
    { ...good(), hours: null },
    { ...good(), raw: [[1, 2]] },
    { ...good(), raw: [[1, "2", 1]] },
    { ...good(), raw: [null] },
    { ...good(), hours: [[1, 1, 1]] },
    { ...good(), hours: [[1, 1, 1, null]] },
    null,
  ];
  for (const entry of bad) {
    assert.deepEqual(normalizeState({ v: 1, updated: 5, runs: 1, targets: { a: good(), b: entry } }), emptyState());
  }
  assert.deepEqual(normalizeState({ v: 1, updated: 5, runs: 1 }), emptyState());
  assert.deepEqual(normalizeState({ v: 1, targets: "x" }), emptyState());
  assert.equal(applyResults({ v: 1, targets: { a: { raw: 1 } } }, [], [TARGETS[0]], START).targets.a.raw, "");
});

test("old 5-minute samples mix with new 10-minute ones and the numbers stay right", () => {
  // 12 h at 5 minutes: 144 samples, the first 12 of them failed.
  const raw = [];
  const hours = [];
  for (let i = 0; i < 144; i++) {
    const t = START + i * 5 * MIN;
    const ok = i < 12 ? 0 : 1;
    raw.push([t / MIN, ok ? 100 : 10_000, ok]);
    if (i % 12 === 0) hours.push([t / HOUR, 12, i === 0 ? 0 : 12, i === 0 ? 0 : 1200]);
  }
  const switched = START + 12 * HOUR;
  let state = { v: 1, updated: switched - 5 * MIN, runs: 144, targets: { a: { url: "u", last: null, raw, hours } } };

  // Then 11 h 50 min at 10 minutes: 72 samples, all up at 200 ms. Nothing leaves the window.
  let t = switched;
  for (let i = 0; i < 72; i++) {
    t = switched + i * STEP;
    state = applyResults(state, [result("a", t, true, 200)], [TARGETS[0]], t);
  }
  const entry = state.targets.a;
  assert.equal(unpackRows(entry.raw).length, 144 + 72);
  // Uptime is the share of passed checks, the same meaning as before the change.
  assert.equal(uptime24h(entry, t), (144 + 72 - 12) / (144 + 72));
  assert.equal(uptime7d(entry, t), (144 + 72 - 12) / (144 + 72));
  assert.equal(avgLatency24h(entry, t), Math.round((132 * 100 + 72 * 200) / 204));
  const counts = unpackRows(entry.hours).map((h) => h[1]);
  assert.deepEqual(counts, [...Array(12).fill(12), ...Array(12).fill(6)]);

  // 13 h later the failed samples have left 24 h uptime, but stay in the 7-day numbers.
  const after = switched + 13 * HOUR;
  assert.equal(uptime24h(entry, after), 1);
  assert.equal(uptime7d(entry, after), (144 + 72 - 12) / (144 + 72));
});
