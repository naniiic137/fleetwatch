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
