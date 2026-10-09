// The Worker and the probe must watch the same sites: compare worker/src/targets.js
// with targets.yaml at the repository root (and the Helm chart's default values).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { TARGETS } from "../src/targets.js";

/** Pull name/url/expect_status out of the simple targets YAML used by FleetWatch. */
function parseTargetsYaml(text) {
  const out = [];
  let current = null;
  let inTargets = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      inTargets = /^targets:\s*$/.test(line);
      continue;
    }
    if (!inTargets) continue;
    const item = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
    const field = line.match(/^\s+(\w+):\s*(.*)$/);
    const kv = item || field;
    if (!kv) continue;
    if (item) {
      current = {};
      out.push(current);
    }
    current[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return out.map((t) => ({ name: t.name, url: t.url, expectStatus: Number(t.expect_status ?? 200) }));
}

const root = new URL("../../", import.meta.url);

test("worker targets match targets.yaml", () => {
  const yaml = parseTargetsYaml(readFileSync(new URL("targets.yaml", root), "utf8"));
  assert.deepEqual(TARGETS, yaml);
});

test("worker targets match the Helm chart defaults", () => {
  const values = readFileSync(new URL("deploy/helm/fleetwatch/values.yaml", root), "utf8");
  assert.deepEqual(TARGETS, parseTargetsYaml(values));
});

test("all targets use https", () => {
  for (const t of TARGETS) assert.match(t.url, /^https:\/\//);
});
