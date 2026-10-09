// Compact rolling history, stored as ONE Workers KV value (key "state").
//
// Per target:
//   last  {t, ok, code, ms, err}       the latest check
//   raw   [[minute, ms, ok], ...]      every check of the last 24 h (288 at 5-min cron)
//   hours [[hour, checks, ups, sumMs]] one bucket per hour for the last 7 days (168)
//
// minute = epoch minutes, hour = epoch hours; ok is 1 or 0; sumMs adds the latency
// of successful checks only. ~85 KB for 10 targets, far under KV's 25 MiB value limit.

export const STATE_KEY = "state";
export const STATE_VERSION = 1;
export const RAW_WINDOW_MINUTES = 24 * 60;
export const HOUR_BUCKETS = 7 * 24;

export function emptyState() {
  return { v: STATE_VERSION, updated: 0, runs: 0, targets: {} };
}

/** Accept whatever KV returned; anything unexpected starts a fresh history. */
export function normalizeState(value) {
  if (!value || typeof value !== "object" || value.v !== STATE_VERSION) return emptyState();
  if (!value.targets || typeof value.targets !== "object") return emptyState();
  return value;
}

/**
 * Fold one cron run's results into the state. Pure: returns a new object.
 * Targets no longer configured are dropped; history older than the windows is pruned.
 */
export function applyResults(state, results, targets, nowMs) {
  const prev = normalizeState(state);
  const nowMinute = Math.floor(nowMs / 60_000);
  const nowHour = Math.floor(nowMs / 3_600_000);
  const byName = new Map(results.map((r) => [r.name, r]));
  const next = { v: STATE_VERSION, updated: nowMs, runs: (prev.runs || 0) + 1, targets: {} };

  for (const target of targets) {
    const old = prev.targets[target.name] || {};
    const raw = Array.isArray(old.raw) ? old.raw.slice() : [];
    const hours = Array.isArray(old.hours) ? old.hours.map((h) => h.slice()) : [];
    let last = old.last || null;

    const result = byName.get(target.name);
    if (result) {
      const ok = result.ok ? 1 : 0;
      raw.push([Math.floor(result.t / 60_000), result.ms, ok]);
      const hour = Math.floor(result.t / 3_600_000);
      let bucket = hours.length ? hours[hours.length - 1] : null;
      if (!bucket || bucket[0] !== hour) {
        bucket = [hour, 0, 0, 0];
        hours.push(bucket);
      }
      bucket[1] += 1;
      bucket[2] += ok;
      bucket[3] += ok ? result.ms : 0;
      last = { t: result.t, ok: !!result.ok, code: result.code, ms: result.ms, err: result.err };
    }

    next.targets[target.name] = {
      url: target.url,
      last,
      raw: raw.filter((p) => p[0] > nowMinute - RAW_WINDOW_MINUTES),
      hours: hours.filter((h) => h[0] > nowHour - HOUR_BUCKETS),
    };
  }
  return next;
}

/** Uptime ratio (0..1) over the raw 24 h samples, or null without data. */
export function uptime24h(entry, nowMs) {
  const from = Math.floor(nowMs / 60_000) - RAW_WINDOW_MINUTES;
  const points = (entry?.raw || []).filter((p) => p[0] > from);
  if (!points.length) return null;
  return points.reduce((sum, p) => sum + p[2], 0) / points.length;
}

/** Uptime ratio (0..1) over the hourly buckets of the last 7 days, or null. */
export function uptime7d(entry, nowMs) {
  const from = Math.floor(nowMs / 3_600_000) - HOUR_BUCKETS;
  let checks = 0;
  let ups = 0;
  for (const h of entry?.hours || []) {
    if (h[0] > from) {
      checks += h[1];
      ups += h[2];
    }
  }
  return checks ? ups / checks : null;
}

/** Average latency (ms) of successful checks in the last 24 h, or null. */
export function avgLatency24h(entry, nowMs) {
  const from = Math.floor(nowMs / 60_000) - RAW_WINDOW_MINUTES;
  const ok = (entry?.raw || []).filter((p) => p[0] > from && p[2] === 1);
  if (!ok.length) return null;
  return Math.round(ok.reduce((sum, p) => sum + p[1], 0) / ok.length);
}

/** One summary row per configured target, in config order. */
export function summarize(state, targets, nowMs) {
  const s = normalizeState(state);
  return targets.map((target) => {
    const entry = s.targets[target.name];
    const last = entry?.last || null;
    return {
      name: target.name,
      url: target.url,
      up: last ? last.ok : null,
      statusCode: last ? last.code : null,
      latencyMs: last ? last.ms : null,
      error: last ? last.err : null,
      lastCheck: last ? last.t : null,
      uptime24h: uptime24h(entry, nowMs),
      uptime7d: uptime7d(entry, nowMs),
      avgLatency24h: avgLatency24h(entry, nowMs),
      points: entry?.raw || [],
    };
  });
}
