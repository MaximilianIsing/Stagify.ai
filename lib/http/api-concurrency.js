// A ceiling on SIMULTANEOUS API renders — the thing a rate limiter cannot express.
//
// WHY THIS EXISTS SEPARATELY FROM apiRenderLimiter. A rate limit counts requests over a
// window; it says nothing about how many are in flight at once. Sixty requests per five
// minutes is a perfectly calm budget that still permits sixty CONCURRENT multi-minute
// renders if a client fires them together — and each one holds a 25 MB multer buffer
// plus sharp's working memory on a single Render instance with a 1 GB disk. The box
// falls over long before the rate limit notices anything unusual.
//
// This is also the piece that makes a synchronous API honest. There is no job queue
// (see docs/guides/architecture.md), so back-pressure has to be expressed as a refusal
// at the door rather than as a growing queue depth: a caller told 429 immediately can
// retry, where a caller left waiting on a saturated box just times out and retries
// anyway, having spent our CPU to learn nothing.
//
// IN-PROCESS AND DELIBERATELY SO. The counter is a Map in one process, which is exactly
// as far as it needs to reach: the app is single-instance by construction (SQLite with
// a single writer on an attached disk), so a shared counter would add a dependency to
// solve a problem that cannot occur. If the app is ever scaled horizontally, this is
// one of the several things that has to change — and it will be far from the first.

/**
 * Build a per-key + global concurrency gate.
 * @param {{ limit?: number, globalLimit?: number, onReject?: (req: any, scope: string) => void }} [opts]
 *   Per-key ceiling, process-wide ceiling, and an optional rejection hook (the router
 *   passes the rejection logger so a refusal here is as visible as a 429 from a limiter).
 * @returns {{ gate: import('express').RequestHandler, inFlight: () => number, forKey: (id: string) => number }}
 *   The middleware plus read-only counters for tests and the status endpoint.
 */
export function createConcurrencyGate(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : 3;
  const globalLimit = Number.isFinite(opts.globalLimit) ? Number(opts.globalLimit) : 12;
  const onReject = typeof opts.onReject === 'function' ? opts.onReject : () => {};

  /** @type {Map<string, number>} */
  const perKey = new Map();
  let total = 0;

  /**
   * Release a slot exactly once, however the response ended.
   *
   * Both 'finish' and 'close' are listened for: 'finish' fires on a normal response,
   * 'close' on a client that hung up mid-render — and a render is long enough that
   * abandoned requests are routine, not exotic. Leak a slot on either and the gate
   * ratchets shut over hours until every caller sees 429 and nothing is in flight.
   * @param {string} id - The bucket key.
   * @returns {() => void} The idempotent release.
   */
  function releaser(id) {
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      total -= 1;
      const n = (perKey.get(id) || 1) - 1;
      // Delete rather than leave a zero: otherwise the Map grows one entry per key
      // that ever called, forever, which on a public API is unbounded.
      if (n <= 0) perKey.delete(id);
      else perKey.set(id, n);
    };
  }

  /** @type {import('express').RequestHandler} */
  function gate(req, res, next) {
    // Runs AFTER requireApiKey, so the key is always there; the IP fallback only
    // covers a misordered chain in a future edit rather than any live path.
    const id = req.apiKey?.id || req.ip || 'unknown';

    if (total >= globalLimit) {
      onReject(req, 'global');
      res.status(429).json({
        error: 'The service is busy. Please retry in a few seconds.',
        code: 'CONCURRENCY_LIMIT',
      });
      return;
    }
    const mine = perKey.get(id) || 0;
    if (mine >= limit) {
      onReject(req, 'key');
      res.status(429).json({
        error: `At most ${limit} renders may be in flight at once for one API key.`,
        code: 'CONCURRENCY_LIMIT',
      });
      return;
    }

    total += 1;
    perKey.set(id, mine + 1);
    const release = releaser(id);
    res.on('finish', release);
    res.on('close', release);
    return next();
  }

  return {
    gate,
    inFlight: () => total,
    forKey: (id) => perKey.get(id) || 0,
  };
}
