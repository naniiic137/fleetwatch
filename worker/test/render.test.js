import assert from "node:assert/strict";
import { test } from "node:test";

import {
  escapeHtml,
  formatPercent,
  hostOf,
  metricsText,
  overall,
  relativeTime,
  renderStatusPage,
  sparkline,
  statusJson,
} from "../src/render.js";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const NOW_MIN = NOW / 60_000;

function row(overrides = {}) {
  return {
    name: "site",
    url: "https://site.example",
    up: true,
    statusCode: 200,
    latencyMs: 120,
    error: null,
    lastCheck: NOW - 3 * 60_000,
    uptime24h: 0.99653,
    uptime7d: 1,
    avgLatency24h: 110,
    points: [
      [NOW_MIN - 15, 100, 1],
      [NOW_MIN - 10, 140, 1],
      [NOW_MIN - 5, 0, 0],
      [NOW_MIN, 120, 1],
    ],
    ...overrides,
  };
}

test("helpers", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(formatPercent(1), "100%");
  assert.equal(formatPercent(0.99999), "99.99%");
  assert.equal(formatPercent(null), "n/a");
  assert.equal(relativeTime(NOW - 30_000, NOW), "just now");
  assert.equal(relativeTime(NOW - 7 * 60_000, NOW), "7 min ago");
  assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), "3 h ago");
  assert.equal(relativeTime(null, NOW), "never");
  assert.equal(hostOf("https://www.example.com/path"), "www.example.com");
});

test("overall banner", () => {
  assert.equal(overall([row()]).text, "All systems operational");
  assert.equal(overall([row(), row({ up: false })]).text, "1 of 2 sites down");
  assert.equal(overall([row({ up: false })]).text, "All sites are down");
  assert.equal(overall([row({ up: null })]).level, "unknown");
});

test("sparkline draws a broken line plus failure ticks", () => {
  const svg = sparkline(row().points, NOW);
  assert.match(svg, /^<svg class="spark" viewBox="0 0 300 44"/);
  assert.equal((svg.match(/<polyline /g) || []).length, 1); // 2 points before the failure
  assert.equal((svg.match(/<circle /g) || []).length, 1); // the single point after it
  assert.equal((svg.match(/class="spark-fail"/g) || []).length, 1);
  assert.match(svg, /aria-label="Latency over 24 hours: 3 successful checks, average 120 ms, peak 140 ms, 1 failed"/);
  // the newest point sits at the right edge, the peak at the top padding
  assert.match(svg, /cx="300\.0"/);
  assert.match(svg, /,4\.0/);
});

test("sparkline handles no data", () => {
  const svg = sparkline([], NOW);
  assert.match(svg, /No checks in the last 24 hours yet/);
  assert.doesNotMatch(svg, /polyline/);
});

test("status page escapes names and shows the numbers", () => {
  const html = renderStatusPage([row({ name: "<b>evil</b>" }), row({ name: "down", up: false, statusCode: 503, error: "expected 200, got 503" })], {
    nowMs: NOW,
    updatedMs: NOW - 3 * 60_000,
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;b&gt;evil&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>evil<\/b>/);
  assert.match(html, /1 of 2 sites down/);
  assert.match(html, /99\.65%/);
  assert.match(html, /Down · 503/);
  assert.match(html, /expected 200, got 503/);
  assert.match(html, /Last check 3 min ago · every 5 min/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /prefers-color-scheme:dark/);
});

test("status JSON", () => {
  const json = statusJson([row(), row({ name: "x", up: null, statusCode: null, latencyMs: null, lastCheck: null, uptime24h: null, uptime7d: null })], {
    nowMs: NOW,
    updatedMs: NOW,
  });
  assert.equal(json.status, "up");
  assert.deepEqual(json.counts, { total: 2, up: 1, down: 0, unknown: 1 });
  assert.equal(json.targets[0].uptime24hPercent, 99.653);
  assert.equal(json.targets[0].lastCheckAt, "2026-10-09T11:57:00.000Z");
  assert.equal(json.targets[1].uptime7dPercent, null);
});

test("metrics text is valid exposition format", () => {
  const text = metricsText([row(), row({ name: 'q"x', up: false, statusCode: 0 }), row({ name: "new", up: null, latencyMs: null, lastCheck: null, uptime24h: null, uptime7d: null })], {
    updatedMs: NOW,
  });
  assert.ok(text.endsWith("\n"));
  const sample = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*"(,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*")*\})? (NaN|[+-]Inf|-?[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)?)$/;
  for (const line of text.trimEnd().split("\n")) {
    if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) continue;
    assert.match(line, sample, line);
  }
  assert.match(text, /^fleetwatch_worker_up\{target="site",url="https:\/\/site\.example"\} 1$/m);
  assert.match(text, /^fleetwatch_worker_up\{target="q\\"x",url="https:\/\/site\.example"\} 0$/m);
  assert.match(text, /^fleetwatch_worker_uptime_ratio\{target="site",window="24h"\} 0\.99653$/m);
  assert.match(text, /^fleetwatch_worker_latency_seconds\{target="site"\} 0\.12$/m);
  assert.doesNotMatch(text, /target="new"/);
  assert.match(text, /^# TYPE fleetwatch_worker_up gauge$/m);
  assert.match(text, /^fleetwatch_worker_state_updated_timestamp_seconds 1791547200$/m);
});
