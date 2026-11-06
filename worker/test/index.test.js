import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker, { handleRequest, runChecks } from "../src/index.js";
import { normalizeState, STATE_KEY, unpackRows } from "../src/history.js";
import { CHECK_INTERVAL_MINUTES } from "../src/render.js";
import { TARGETS } from "../src/targets.js";
import { FakeKV, makeClock, scriptedFetch, v1State } from "./helpers.js";

const START = Date.UTC(2026, 9, 9, 12, 0, 0);
const targets = [
  { name: "a", url: "https://a.example", expectStatus: 200 },
  { name: "b", url: "https://b.example", expectStatus: 200 },
];

test("a cron run writes exactly one KV key", async () => {
  const kv = new FakeKV();
  const clock = makeClock(START);
  const fetchImpl = scriptedFetch({ "https://b.example": 500 }, clock);
  await runChecks({ FW_KV: kv }, { targets, fetchImpl, now: clock });
  assert.equal(kv.writes, 1);
  assert.deepEqual([...kv.store.keys()], [STATE_KEY]);
  const state = JSON.parse(kv.store.get(STATE_KEY));
  assert.equal(state.targets.a.last.ok, true);
  assert.equal(state.targets.b.last.code, 500);
});

test("a day of cron runs stays within the KV free tier", async () => {
  const kv = new FakeKV();
  const clock = makeClock(START);
  const fetchImpl = scriptedFetch({}, clock, 50);
  const runsPerDay = (24 * 60) / CHECK_INTERVAL_MINUTES;
  for (let i = 0; i < runsPerDay; i++) {
    clock.set(START + i * CHECK_INTERVAL_MINUTES * 60_000);
    await runChecks({ FW_KV: kv }, { targets: TARGETS, fetchImpl, now: clock });
  }
  assert.equal(kv.writes, 144);
  assert.ok(kv.writes < 1000, "free plan allows 1,000 writes/day");
  assert.ok(kv.store.get(STATE_KEY).length < 25 * 1024 * 1024);
});

async function seeded() {
  const kv = new FakeKV();
  const clock = makeClock(START);
  await runChecks({ FW_KV: kv }, { targets, fetchImpl: scriptedFetch({ "https://b.example": 503 }, clock), now: clock });
  return { env: { FW_KV: kv }, now: () => START + 60_000 };
}

test("GET / serves the status page", async () => {
  const { env, now } = await seeded();
  const res = await handleRequest(new Request("https://fw.example/"), env, { targets, now });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /1 of 2 sites down/);
});

test("GET /api/status serves JSON", async () => {
  const { env, now } = await seeded();
  const res = await handleRequest(new Request("https://fw.example/api/status"), env, { targets, now });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json();
  assert.equal(body.counts.down, 1);
  assert.equal(body.targets[1].statusCode, 503);
});

test("GET /metrics serves Prometheus text", async () => {
  const { env, now } = await seeded();
  const res = await handleRequest(new Request("https://fw.example/metrics"), env, { targets, now });
  assert.equal(res.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
  assert.match(await res.text(), /fleetwatch_worker_up\{target="b",url="https:\/\/b\.example"\} 0/);
});

test("empty KV renders a waiting page, unknown paths 404, POST 405", async () => {
  const env = { FW_KV: new FakeKV() };
  const page = await handleRequest(new Request("https://fw.example/"), env, { targets });
  assert.match(await page.text(), /Waiting for the first check/);
  assert.equal((await handleRequest(new Request("https://fw.example/nope"), env)).status, 404);
  assert.equal((await handleRequest(new Request("https://fw.example/", { method: "POST" }), env)).status, 405);
});

test("default export wires fetch and scheduled", async () => {
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.scheduled, "function");
  const kv = new FakeKV();
  const waited = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  const realLog = console.log;
  console.log = () => {};
  try {
    await worker.scheduled({ cron: "*/10 * * * *" }, { FW_KV: kv }, { waitUntil: (p) => waited.push(p) });
    await Promise.all(waited);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(kv.writes, 1);
  const state = JSON.parse(kv.store.get(STATE_KEY));
  assert.deepEqual(Object.keys(state.targets), TARGETS.map((t) => t.name));
});

test("the cron in wrangler.jsonc matches the interval the page shows", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.equal(CHECK_INTERVAL_MINUTES, 10);
  assert.ok(config.includes(`"crons": ["*/${CHECK_INTERVAL_MINUTES} * * * *"]`));
});

test("the first cron run on a v1 state keeps the history and writes once", async () => {
  const v1 = v1State(targets, START);
  const before = v1.targets.a;
  const kv = new FakeKV({ [STATE_KEY]: JSON.stringify(v1) });
  const clock = makeClock(START + 10 * 60_000);
  const { results } = await runChecks({ FW_KV: kv }, { targets, fetchImpl: scriptedFetch({}, clock), now: clock });
  const { t, ms } = results[0];
  assert.equal(kv.writes, 1);
  assert.deepEqual([...kv.store.keys()], [STATE_KEY]);

  const stored = JSON.parse(kv.store.get(STATE_KEY));
  assert.equal(stored.v, 2);
  assert.equal(stored.runs, v1.runs + 1);
  assert.equal(stored.targets.a.url, undefined);
  const newest = [Math.floor(t / 60_000), ms, 1];
  // Only the two samples that really left the 24 h window are gone.
  assert.deepEqual(unpackRows(stored.targets.a.raw), [...before.raw.slice(2), newest]);
  const hours = unpackRows(stored.targets.a.hours);
  const [hour, checks, ups, sumMs] = before.hours.at(-1);
  assert.deepEqual(hours, [...before.hours.slice(0, -1), [hour, checks + 1, ups + 1, sumMs + ms]]);
});

test("a v1 state and its conversion serve the same page, JSON and metrics", async () => {
  const v1 = v1State(targets, START);
  const serve = async (state) => {
    const env = { FW_KV: new FakeKV({ [STATE_KEY]: JSON.stringify(state) }) };
    const out = [];
    for (const path of ["/", "/api/status", "/metrics"]) {
      const res = await handleRequest(new Request(`https://fw.example${path}`), env, { targets, now: () => START });
      out.push(await res.text());
    }
    return out;
  };
  const [page, json, metrics] = await serve(v1);
  assert.deepEqual([page, json, metrics], await serve(normalizeState(v1)));

  // The numbers are the ones the v1 samples give, worked out here by hand.
  const row = JSON.parse(json).targets[0];
  const raw = v1.targets.a.raw;
  const ok = raw.filter((p) => p[2] === 1);
  const checks = v1.targets.a.hours.reduce((sum, h) => sum + h[1], 0);
  const ups = v1.targets.a.hours.reduce((sum, h) => sum + h[2], 0);
  assert.ok(ok.length < raw.length, "the fixture has failed checks");
  assert.equal(raw.length, 288);
  assert.equal(row.uptime24hPercent, Math.round((ok.length / raw.length) * 100_000) / 1000);
  assert.equal(row.avgLatency24hMs, Math.round(ok.reduce((sum, p) => sum + p[1], 0) / ok.length));
  assert.equal(row.uptime7dPercent, Math.round((ups / checks) * 100_000) / 1000);
  assert.equal(row.url, "https://a.example");
  assert.match(page, /every 10 min/);
  assert.match(metrics, /^fleetwatch_worker_up\{target="a",url="https:\/\/a\.example"\} [01]$/m);
});
