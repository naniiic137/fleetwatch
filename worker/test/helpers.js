// Test doubles: an in-memory KV namespace and a scripted fetch. No network.

export class FakeKV {
  constructor(initial = {}) {
    this.store = new Map(Object.entries(initial));
    this.writes = 0;
    this.reads = 0;
  }
  async get(key, type) {
    this.reads += 1;
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.writes += 1;
    this.store.set(key, value);
  }
}

/** fetch that answers per URL: a number = status, "timeout"/"error" = failure. Advances the clock. */
export function scriptedFetch(plan, clock, latencyMs = 120) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const outcome = plan[url] ?? 200;
    clock.advance(latencyMs);
    if (outcome === "timeout") {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    if (outcome === "error") throw new TypeError("Network connection lost.");
    return new Response("<html>ok</html>", { status: outcome });
  };
  impl.calls = calls;
  return impl;
}

export function makeClock(start) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  now.set = (ms) => {
    t = ms;
  };
  return now;
}

/**
 * A state as the version 1 code left it after 7 days of checks at 5-minute spacing:
 * arrays of arrays, a url per site, some failed checks. Same result as running it.
 */
export function v1State(targets, nowMs) {
  const STEP = 5 * 60_000;
  const nowMinute = Math.floor(nowMs / 60_000);
  const nowHour = Math.floor(nowMs / 3_600_000);
  const state = { v: 1, updated: nowMs, runs: 2016, targets: {} };
  targets.forEach((target, n) => {
    const raw = [];
    const hours = [];
    let last = null;
    for (let i = 2015; i >= 0; i--) {
      const t = nowMs - i * STEP;
      const ok = (i + n) % 97 === 5 ? 0 : 1;
      const ms = ok ? 80 + ((i * 37 + n * 11) % 400) : 10_000;
      raw.push([Math.floor(t / 60_000), ms, ok]);
      const hour = Math.floor(t / 3_600_000);
      if (hours.at(-1)?.[0] !== hour) hours.push([hour, 0, 0, 0]);
      const bucket = hours.at(-1);
      bucket[1] += 1;
      bucket[2] += ok;
      bucket[3] += ok ? ms : 0;
      last = ok
        ? { t, ok: true, code: 200, ms, err: null }
        : { t, ok: false, code: 0, ms, err: "timeout after 10000 ms" };
    }
    state.targets[target.name] = {
      url: target.url,
      last,
      raw: raw.filter((p) => p[0] > nowMinute - 24 * 60),
      hours: hours.filter((b) => b[0] > nowHour - 7 * 24),
    };
  });
  return JSON.parse(JSON.stringify(state));
}
