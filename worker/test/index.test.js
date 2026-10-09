import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { handleRequest, runChecks } from "../src/index.js";
import { STATE_KEY } from "../src/history.js";
import { TARGETS } from "../src/targets.js";
import { FakeKV, makeClock, scriptedFetch } from "./helpers.js";

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
  const runsPerDay = (24 * 60) / 5;
  for (let i = 0; i < runsPerDay; i++) {
    clock.set(START + i * 5 * 60_000);
    await runChecks({ FW_KV: kv }, { targets: TARGETS, fetchImpl, now: clock });
  }
  assert.equal(kv.writes, 288);
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
    await worker.scheduled({ cron: "*/5 * * * *" }, { FW_KV: kv }, { waitUntil: (p) => waited.push(p) });
    await Promise.all(waited);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(kv.writes, 1);
  const state = JSON.parse(kv.store.get(STATE_KEY));
  assert.deepEqual(Object.keys(state.targets), TARGETS.map((t) => t.name));
});
