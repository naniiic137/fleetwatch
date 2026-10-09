// FleetWatch Worker: checks the sites on a Cron Trigger (every 5 minutes) and
// serves a public status page, /api/status (JSON) and /metrics (Prometheus).
//
// KV budget: exactly ONE write per cron run (288/day), see README "KV math".

import { checkAll } from "./check.js";
import { applyResults, normalizeState, STATE_KEY, summarize } from "./history.js";
import { metricsText, renderStatusPage, statusJson } from "./render.js";
import { TARGETS } from "./targets.js";

/** One cron run: check every target, fold results into history, write KV once. */
export async function runChecks(env, { targets = TARGETS, fetchImpl, now = Date.now } = {}) {
  const startedAt = now();
  const [previous, results] = await Promise.all([
    env.FW_KV.get(STATE_KEY, "json"),
    checkAll(targets, { fetchImpl, now }),
  ]);
  const state = applyResults(previous, results, targets, startedAt);
  await env.FW_KV.put(STATE_KEY, JSON.stringify(state));
  return { state, results };
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function respond(body, contentType, extra = {}) {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=60",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

/** HTTP handler, exported separately so tests can call it with a fake env. */
export async function handleRequest(request, env, { targets = TARGETS, now = Date.now } = {}) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const known = ["/", "/api/status", "/metrics"];
  if (!known.includes(url.pathname)) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
    });
  }

  const state = normalizeState(await env.FW_KV.get(STATE_KEY, "json"));
  const nowMs = now();
  const summaries = summarize(state, targets, nowMs);
  const ctx = { nowMs, updatedMs: state.updated || null };

  if (url.pathname === "/api/status") {
    return respond(JSON.stringify(statusJson(summaries, ctx), null, 2), "application/json; charset=utf-8", {
      "access-control-allow-origin": "*",
    });
  }
  if (url.pathname === "/metrics") {
    return respond(metricsText(summaries, ctx), "text/plain; version=0.0.4; charset=utf-8");
  }
  return respond(renderStatusPage(summaries, ctx), "text/html; charset=utf-8", {
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runChecks(env).then(({ results }) => {
        const down = results.filter((r) => !r.ok);
        console.log(
          JSON.stringify({
            msg: "fleetwatch cron run",
            cron: controller.cron,
            up: results.length - down.length,
            down: down.map((r) => ({ name: r.name, err: r.err })),
          }),
        );
      }),
    );
  },
};
