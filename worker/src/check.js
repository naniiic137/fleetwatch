// One HTTP check, timed. Pure apart from the injected fetch and clock.

export const USER_AGENT = "fleetwatch-worker/0.1 (+https://github.com/naniiic137/fleetwatch)";

/**
 * Check one target.
 * @param {{name: string, url: string, expectStatus?: number}} target
 * @param {{fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number}} [opts]
 * @returns {Promise<{name: string, url: string, t: number, ok: boolean, code: number, ms: number, err: string|null}>}
 */
export async function checkTarget(target, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const expected = target.expectStatus ?? 200;
  const started = now();
  try {
    const res = await fetchImpl(target.url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Time to response headers. In Workers the clock advances only across I/O,
    // which is exactly what we want to measure here.
    const ms = Math.max(0, Math.round(now() - started));
    // We only need the status: drop the body without reading it (saves CPU time).
    if (res.body && typeof res.body.cancel === "function") {
      try {
        await res.body.cancel();
      } catch {
        // ignore
      }
    }
    const ok = res.status === expected;
    return {
      name: target.name,
      url: target.url,
      t: started,
      ok,
      code: res.status,
      ms,
      err: ok ? null : `expected ${expected}, got ${res.status}`,
    };
  } catch (error) {
    const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      name: target.name,
      url: target.url,
      t: started,
      ok: false,
      code: 0,
      ms: Math.max(0, Math.round(now() - started)),
      err: timedOut ? `timeout after ${timeoutMs} ms` : `fetch failed: ${errorMessage(error)}`,
    };
  }
}

function errorMessage(error) {
  const text = error && error.message ? String(error.message) : String(error);
  return text.slice(0, 200);
}

/** Check all targets concurrently. */
export function checkAll(targets, opts = {}) {
  return Promise.all(targets.map((target) => checkTarget(target, opts)));
}
