// Compact rolling history, stored as ONE Workers KV value (key "state").
//
// Per target:
//   last   {t, ok, code, ms, err}        the latest check
//   raw    "minute,ms,ok;..."            every check of the last 24 h (144 at 10-min cron)
//   hours  "hour,checks,ups,sumMs;..."   one bucket per hour for the last 7 days (168)
//
// minute = epoch minutes, hour = epoch hours; ok is 1 or 0; sumMs adds the latency
// of successful checks only. raw and hours are plain strings, oldest row first, so a
// cron run adds to the end and cuts from the front without parsing every row. They
// are unpacked only when the page or the API is served. ~110 KB for 22 targets, far
// under KV's 25 MiB value limit.
//
// Version 1 kept the same rows as arrays of arrays, plus each site's url.

export const STATE_KEY = "state";
export const STATE_VERSION = 2;
export const RAW_WINDOW_MINUTES = 24 * 60;
export const HOUR_BUCKETS = 7 * 24;

export function emptyState() {
  return { v: STATE_VERSION, updated: 0, runs: 0, targets: {} };
}

/**
 * Rows as arrays of numbers. Rows that are already unpacked pass through, and a
 * damaged string counts as no data. JSON.parse is much faster here than split().
 */
export function unpackRows(rows) {
  if (Array.isArray(rows)) return rows;
  if (typeof rows !== "string" || !rows) return [];
  try {
    return JSON.parse(`[[${rows.replaceAll(";", "],[")}]]`);
  } catch {
    return [];
  }
}

function addRow(rows, row) {
  return rows ? `${rows};${row}` : row;
}

/** Cut rows from the front until the first number of a row is after `oldest`. */
function trimRows(rows, oldest) {
  let start = 0;
  while (start < rows.length && !(Number(rows.slice(start, rows.indexOf(",", start))) > oldest)) {
    const end = rows.indexOf(";", start);
    if (end === -1) return "";
    start = end + 1;
  }
  return rows.slice(start);
}

/** Count one check in the newest bucket, or start a new bucket for a new hour. */
function addToHour(hours, hour, ok, ms) {
  const start = hours.lastIndexOf(";") + 1;
  const [newest, checks, ups, sumMs] = hours.slice(start).split(",").map(Number);
  if (newest !== hour) return addRow(hours, `${hour},1,${ok},${ms}`);
  return `${hours.slice(0, start)}${hour},${checks + 1},${ups + ok},${sumMs + ms}`;
}

function isRows(rows, width) {
  return (
    Array.isArray(rows) &&
    rows.every((row) => Array.isArray(row) && row.length === width && row.every(Number.isFinite))
  );
}

/** Convert a version 1 state, keeping every sample. Null if its shape is off. */
function fromV1(value) {
  const targets = {};
  for (const [name, entry] of Object.entries(value.targets)) {
    if (!entry || !isRows(entry.raw, 3) || !isRows(entry.hours, 4)) return null;
    targets[name] = {
      last: entry.last || null,
      raw: entry.raw.map((row) => row.join(",")).join(";"),
      hours: entry.hours.map((row) => row.join(",")).join(";"),
    };
  }
  return { v: STATE_VERSION, updated: value.updated, runs: value.runs, targets };
}

/** Accept whatever KV returned; anything unexpected starts a fresh history. */
export function normalizeState(value) {
  if (!value || typeof value !== "object") return emptyState();
  if (!value.targets || typeof value.targets !== "object") return emptyState();
  if (value.v === 1) return fromV1(value) || emptyState();
  return value.v === STATE_VERSION ? value : emptyState();
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
    let raw = typeof old.raw === "string" ? old.raw : "";
    let hours = typeof old.hours === "string" ? old.hours : "";
    let last = old.last || null;

    const result = byName.get(target.name);
    if (result) {
      const ok = result.ok ? 1 : 0;
      raw = addRow(raw, `${Math.floor(result.t / 60_000)},${result.ms},${ok}`);
      hours = addToHour(hours, Math.floor(result.t / 3_600_000), ok, ok ? result.ms : 0);
      last = { t: result.t, ok: !!result.ok, code: result.code, ms: result.ms, err: result.err };
    }

    next.targets[target.name] = {
      last,
      raw: trimRows(raw, nowMinute - RAW_WINDOW_MINUTES),
      hours: trimRows(hours, nowHour - HOUR_BUCKETS),
    };
  }
  return next;
}

/** Uptime ratio (0..1) over the raw 24 h samples, or null without data. */
export function uptime24h(entry, nowMs) {
  const from = Math.floor(nowMs / 60_000) - RAW_WINDOW_MINUTES;
  const points = unpackRows(entry?.raw).filter((p) => p[0] > from);
  if (!points.length) return null;
  return points.reduce((sum, p) => sum + p[2], 0) / points.length;
}

/** Uptime ratio (0..1) over the hourly buckets of the last 7 days, or null. */
export function uptime7d(entry, nowMs) {
  const from = Math.floor(nowMs / 3_600_000) - HOUR_BUCKETS;
  let checks = 0;
  let ups = 0;
  for (const h of unpackRows(entry?.hours)) {
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
  const ok = unpackRows(entry?.raw).filter((p) => p[0] > from && p[2] === 1);
  if (!ok.length) return null;
  return Math.round(ok.reduce((sum, p) => sum + p[1], 0) / ok.length);
}

/** One summary row per configured target, in config order. */
export function summarize(state, targets, nowMs) {
  const s = normalizeState(state);
  return targets.map((target) => {
    const entry = s.targets[target.name];
    const last = entry?.last || null;
    const rows = { raw: unpackRows(entry?.raw), hours: unpackRows(entry?.hours) };
    return {
      name: target.name,
      url: target.url,
      up: last ? last.ok : null,
      statusCode: last ? last.code : null,
      latencyMs: last ? last.ms : null,
      error: last ? last.err : null,
      lastCheck: last ? last.t : null,
      uptime24h: uptime24h(rows, nowMs),
      uptime7d: uptime7d(rows, nowMs),
      avgLatency24h: avgLatency24h(rows, nowMs),
      points: rows.raw,
    };
  });
}
