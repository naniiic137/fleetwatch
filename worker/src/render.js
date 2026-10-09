// Rendering: status page HTML, inline SVG sparklines, JSON and Prometheus text.
// All pure functions of (summaries, timestamps).

import { RAW_WINDOW_MINUTES } from "./history.js";

export const CHECK_INTERVAL_MINUTES = 5;
const REPO_URL = "https://github.com/naniiic137/fleetwatch";

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatPercent(ratio) {
  if (ratio === null || ratio === undefined) return "n/a";
  const pct = ratio * 100;
  if (pct === 100) return "100%";
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

export function relativeTime(thenMs, nowMs) {
  if (!thenMs) return "never";
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Inline SVG sparkline of the last 24 h of latency.
 * Successful checks draw a line (broken across gaps and failures); failed checks
 * are red ticks along the bottom. x is real time, so missing runs show as gaps.
 */
export function sparkline(points, nowMs, opts = {}) {
  const width = opts.width ?? 300;
  const height = opts.height ?? 44;
  const pad = 4;
  const end = Math.floor(nowMs / 60_000);
  const start = end - RAW_WINDOW_MINUTES;
  const inWindow = points.filter((p) => p[0] > start && p[0] <= end);
  const okPoints = inWindow.filter((p) => p[2] === 1);
  const maxMs = Math.max(1, ...okPoints.map((p) => p[1]));
  const x = (minute) => (((minute - start) / RAW_WINDOW_MINUTES) * width).toFixed(1);
  const y = (ms) => (height - pad - (ms / maxMs) * (height - 2 * pad)).toFixed(1);

  const segments = [];
  let current = [];
  let prevMinute = null;
  for (const p of inWindow) {
    const gap = prevMinute !== null && p[0] - prevMinute > CHECK_INTERVAL_MINUTES * 3;
    if (p[2] !== 1 || gap) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (p[2] === 1) current.push(`${x(p[0])},${y(p[1])}`);
    prevMinute = p[0];
  }
  if (current.length) segments.push(current);

  const lines = segments
    .map((seg) =>
      seg.length === 1
        ? `<circle cx="${seg[0].split(",")[0]}" cy="${seg[0].split(",")[1]}" r="1.5" class="spark-dot"/>`
        : `<polyline points="${seg.join(" ")}" class="spark-line" vector-effect="non-scaling-stroke"/>`,
    )
    .join("");
  const failures = inWindow
    .filter((p) => p[2] !== 1)
    .map(
      (p) =>
        `<line x1="${x(p[0])}" x2="${x(p[0])}" y1="${height - 9}" y2="${height}" class="spark-fail" vector-effect="non-scaling-stroke"/>`,
    )
    .join("");

  const avg = okPoints.length
    ? Math.round(okPoints.reduce((s, p) => s + p[1], 0) / okPoints.length)
    : null;
  const label = inWindow.length
    ? `Latency over 24 hours: ${okPoints.length} successful checks, average ${avg ?? "n/a"} ms, peak ${okPoints.length ? maxMs : "n/a"} ms, ${inWindow.length - okPoints.length} failed`
    : "No checks in the last 24 hours yet";

  return (
    `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}">` +
    `<title>${escapeHtml(label)}</title>` +
    `<line x1="0" x2="${width}" y1="${height - 0.5}" y2="${height - 0.5}" class="spark-base" vector-effect="non-scaling-stroke"/>` +
    lines +
    failures +
    `</svg>`
  );
}

export function overall(summaries) {
  const known = summaries.filter((s) => s.up !== null);
  const down = known.filter((s) => !s.up).length;
  if (!known.length) return { level: "unknown", text: "Waiting for the first check" };
  if (down === 0) return { level: "up", text: "All systems operational" };
  if (down === known.length) return { level: "down", text: "All sites are down" };
  return { level: "down", text: `${down} of ${summaries.length} sites down` };
}

function card(s, nowMs) {
  const state = s.up === null ? "unknown" : s.up ? "up" : "down";
  const pill =
    state === "unknown" ? "No data" : state === "up" ? `Up · ${s.statusCode}` : s.statusCode ? `Down · ${s.statusCode}` : "Down";
  const checked = s.lastCheck
    ? `<time datetime="${new Date(s.lastCheck).toISOString()}" title="${new Date(s.lastCheck).toISOString()}">${relativeTime(s.lastCheck, nowMs)}</time>`
    : "never";
  const error = s.up === false && s.error ? `<p class="err">${escapeHtml(s.error)}</p>` : "";
  return `
    <li class="card ${state}">
      <div class="card-head">
        <span class="dot" aria-hidden="true"></span>
        <div class="who">
          <h2>${escapeHtml(s.name)}</h2>
          <a href="${escapeHtml(s.url)}" rel="noopener">${escapeHtml(hostOf(s.url))}</a>
        </div>
        <span class="pill">${escapeHtml(pill)}</span>
      </div>
      <dl class="stats">
        <div><dt>24 h</dt><dd>${formatPercent(s.uptime24h)}</dd></div>
        <div><dt>7 days</dt><dd>${formatPercent(s.uptime7d)}</dd></div>
        <div><dt>Latency</dt><dd>${s.latencyMs === null ? "n/a" : `${s.latencyMs} ms`}</dd></div>
      </dl>
      ${sparkline(s.points, nowMs)}
      <p class="checked">Last check ${checked}</p>
      ${error}
    </li>`;
}

const CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--text:#14171c;--muted:#5d6672;--border:#e3e6ea;--accent:#2f6fed;
--up:#14894a;--up-bg:#e5f5ec;--down:#c62f2f;--down-bg:#fbe9e9;--unknown:#6b7480;--unknown-bg:#eef0f3;--spark:#2f6fed;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1216;--surface:#171b21;--text:#e7eaee;--muted:#98a2ae;
--border:#262c34;--accent:#6c9bff;--up:#3ccf7e;--up-bg:#11281c;--down:#ff6b6b;--down-bg:#2e1517;--unknown:#98a2ae;--unknown-bg:#1f242b;--spark:#6c9bff;color-scheme:dark}}
:root[data-theme=dark]{--bg:#0f1216;--surface:#171b21;--text:#e7eaee;--muted:#98a2ae;--border:#262c34;--accent:#6c9bff;
--up:#3ccf7e;--up-bg:#11281c;--down:#ff6b6b;--down-bg:#2e1517;--unknown:#98a2ae;--unknown-bg:#1f242b;--spark:#6c9bff;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.wrap{max-width:980px;margin:0 auto;padding:24px 16px 40px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:10px}
.brand h1{font-size:20px;margin:0;letter-spacing:-.01em}
.brand p{margin:0;color:var(--muted);font-size:13px}
.logo{width:32px;height:32px;border-radius:9px;background:var(--accent);display:grid;place-items:center}
.toggle{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;min-height:36px;white-space:nowrap;flex:none}
.banner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:16px 18px;border-radius:14px;
border:1px solid var(--border);background:var(--surface);margin-bottom:20px}
.banner strong{font-size:17px;display:flex;align-items:center;gap:10px}
.banner span{color:var(--muted);font-size:13px}
.banner.up strong{color:var(--up)}.banner.down strong{color:var(--down)}.banner.unknown strong{color:var(--unknown)}
.grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px 12px;min-width:0}
.card-head{display:flex;align-items:center;gap:10px}
.who{min-width:0;flex:1}
.who h2{font-size:15px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who a{font-size:12.5px;color:var(--muted);text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who a:hover{text-decoration:underline}
.dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--unknown)}
.up .dot,.banner.up .dot{background:var(--up);box-shadow:0 0 0 4px var(--up-bg)}
.down .dot,.banner.down .dot{background:var(--down);box-shadow:0 0 0 4px var(--down-bg)}
.banner.unknown .dot{background:var(--unknown)}
.pill{font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;background:var(--unknown-bg);color:var(--unknown)}
.up .pill{background:var(--up-bg);color:var(--up)}.down .pill{background:var(--down-bg);color:var(--down)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:12px 0 8px}
.stats div{min-width:0}
.stats dt{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.stats dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
.spark{display:block;width:100%;height:44px}
.spark-line{fill:none;stroke:var(--spark);stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.spark-dot{fill:var(--spark)}
.spark-fail{stroke:var(--down);stroke-width:2}
.spark-base{stroke:var(--border);stroke-width:1}
.checked{margin:6px 0 0;font-size:12.5px;color:var(--muted)}
.err{margin:4px 0 0;font-size:12.5px;color:var(--down);overflow-wrap:anywhere}
footer{margin-top:28px;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 16px}
`;

const THEME_SCRIPT = `
(function(){var r=document.documentElement,b=document.getElementById('theme');
function get(){try{return localStorage.getItem('fw-theme')}catch(e){return null}}
function set(v){try{v?localStorage.setItem('fw-theme',v):localStorage.removeItem('fw-theme')}catch(e){}}
function apply(v){if(v)r.setAttribute('data-theme',v);else r.removeAttribute('data-theme');
var dark=v?v==='dark':matchMedia('(prefers-color-scheme: dark)').matches;b.textContent=dark?'Light mode':'Dark mode';}
apply(get());b.hidden=false;
b.addEventListener('click',function(){var dark=r.getAttribute('data-theme')?r.getAttribute('data-theme')==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
var v=dark?'light':'dark';set(v);apply(v);});})();
`;

export function renderStatusPage(summaries, { nowMs, updatedMs }) {
  const o = overall(summaries);
  const cards = summaries.map((s) => card(s, nowMs)).join("");
  const updated = updatedMs
    ? `Last check ${relativeTime(updatedMs, nowMs)} · every ${CHECK_INTERVAL_MINUTES} min`
    : `Checks run every ${CHECK_INTERVAL_MINUTES} minutes`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Live uptime and latency of Hamza Ben Ismail's sites, checked every 5 minutes from Cloudflare.">
<title>FleetWatch Status</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%2314894a'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="logo" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 12 6 12 9 4 15 20 18 12 22 12"/></svg></div>
      <div><h1>FleetWatch</h1><p>Live status of Hamza Ben Ismail's sites</p></div>
    </div>
    <button class="toggle" id="theme" type="button" hidden>Dark mode</button>
  </header>
  <section class="banner ${o.level}" aria-live="polite">
    <strong><span class="dot" aria-hidden="true"></span>${escapeHtml(o.text)}</strong>
    <span>${escapeHtml(updated)}</span>
  </section>
  <ul class="grid">${cards}
  </ul>
  <footer>
    <span>Checked from Cloudflare's network by a Worker cron trigger.</span>
    <a href="/api/status">JSON</a>
    <a href="/metrics">Prometheus metrics</a>
    <a href="${REPO_URL}" rel="noopener">Source on GitHub</a>
  </footer>
</div>
<script>${THEME_SCRIPT}</script>
</body>
</html>
`;
}

export function statusJson(summaries, { nowMs, updatedMs }) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const round = (r) => (r === null ? null : Math.round(r * 100_000) / 1000);
  const known = summaries.filter((s) => s.up !== null);
  return {
    service: "fleetwatch-worker",
    generatedAt: iso(nowMs),
    updatedAt: iso(updatedMs),
    intervalMinutes: CHECK_INTERVAL_MINUTES,
    status: overall(summaries).level,
    counts: {
      total: summaries.length,
      up: known.filter((s) => s.up).length,
      down: known.filter((s) => !s.up).length,
      unknown: summaries.length - known.length,
    },
    targets: summaries.map((s) => ({
      name: s.name,
      url: s.url,
      up: s.up,
      statusCode: s.statusCode,
      latencyMs: s.latencyMs,
      avgLatency24hMs: s.avgLatency24h,
      uptime24hPercent: round(s.uptime24h),
      uptime7dPercent: round(s.uptime7d),
      lastCheckAt: iso(s.lastCheck),
      error: s.up === false ? s.error : null,
    })),
  };
}

function labelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function promNumber(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

/** Prometheus text exposition format (version 0.0.4). */
export function metricsText(summaries, { updatedMs }) {
  const families = [
    ["fleetwatch_worker_up", "1 if the last check from Cloudflare returned the expected status, else 0.", (s) =>
      s.up === null ? [] : [[{ target: s.name, url: s.url }, s.up ? 1 : 0]]],
    ["fleetwatch_worker_http_status_code", "HTTP status code of the last check (0 = no response).", (s) =>
      s.up === null ? [] : [[{ target: s.name }, s.statusCode ?? 0]]],
    ["fleetwatch_worker_latency_seconds", "Time to response headers of the last check.", (s) =>
      s.latencyMs === null ? [] : [[{ target: s.name }, s.latencyMs / 1000]]],
    ["fleetwatch_worker_uptime_ratio", "Share of passed checks (0-1) over the window.", (s) => [
      ...(s.uptime24h === null ? [] : [[{ target: s.name, window: "24h" }, s.uptime24h]]),
      ...(s.uptime7d === null ? [] : [[{ target: s.name, window: "7d" }, s.uptime7d]]),
    ]],
    ["fleetwatch_worker_last_check_timestamp_seconds", "Unix time of the target's last check.", (s) =>
      s.lastCheck === null ? [] : [[{ target: s.name }, s.lastCheck / 1000]]],
  ];
  const lines = [];
  for (const [name, help, samples] of families) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const s of summaries) {
      for (const [labels, value] of samples(s)) {
        const l = Object.entries(labels)
          .map(([k, v]) => `${k}="${labelValue(v)}"`)
          .join(",");
        lines.push(`${name}{${l}} ${promNumber(value)}`);
      }
    }
  }
  lines.push(
    "# HELP fleetwatch_worker_state_updated_timestamp_seconds Unix time of the last cron run that saved results.",
    "# TYPE fleetwatch_worker_state_updated_timestamp_seconds gauge",
    `fleetwatch_worker_state_updated_timestamp_seconds ${updatedMs ? updatedMs / 1000 : 0}`,
  );
  return lines.join("\n") + "\n";
}
