// Per-subsystem health for /status — "which part is broken", not just "is the process alive".
//
// WHY THIS EXISTS BESIDE lib/data/uptime-monitor.js RATHER THAN INSIDE IT.
// The uptime monitor answers exactly one question, retroactively: did this process stop
// beating? That is an honest availability number and the graphs on /status are right to
// keep showing it. But every failure the process SURVIVES — a dead Gemini key, an R2
// bucket that stopped authenticating, Stripe webhooks piling up unprocessed, Resend down
// so nobody can verify a signup — leaves the page green. Until now the only fix was an
// operator noticing and posting an incident by hand, which requires the operator to
// already know.
//
// So this module reads the evidence the app ALREADY records (render outcomes, stuck
// Stripe events, failing blob deletes) plus a couple of genuinely free probes, and turns
// it into a per-component verdict. It is deliberately not folded into buildSnapshot:
// that function is pure, synchronous and pinned by three spec files, and it persists its
// state to SQLite — component health is I/O-derived and ephemeral. The routes compose the
// two with `rollUp` below.
//
// WHAT IT WILL NEVER DO: call a paid API to see if it is up. A Gemini or OpenAI ping
// costs money on every interval and still would not tell you whether renders succeed.
// The render outcome table does tell you that, and it is free.
//
// Reason codes and the rules that emit them live in ONE file on purpose, exactly as
// lib/staging/unstageable.js keeps its prompt beside its taxonomy: a code emitted by a
// rule that has no entry in HEALTH_REASONS is an untranslatable string on a public page.

import { logger } from '../logger.js';
/**
 * The object key the storage probe HEADs. Exported so a test can assert it satisfies
 * the object store's own key gate — see the note beside its use below.
 */
export const STORAGE_PROBE_KEY = 'renders/00000000000000000000000000000000/after.webp';

/** How long a computed section is served before a refresh is kicked off behind it. */
export const CACHE_MS = 30_000;

/** Per-probe TTLs, so a 30 s refresh does not re-run the expensive ones every time. */
const TTL = Object.freeze({ db: 15_000, storage: 60_000, counters: 30_000 });

/**
 * Probe budgets. These bound how long we WAIT, not how long the work runs.
 * Overridable through `deps.timeouts` as a test seam only — the suite must not spend
 * three real seconds proving that a hung bucket times out.
 */
const DEFAULT_TIMEOUT = Object.freeze({ storage: 3_000, refresh: 5_000 });

/**
 * Thresholds, gathered here because they are the crux of the whole module and belong
 * where a reviewer can argue with them.
 *
 * `RENDER_MIN_SAMPLE` has to be a COUNT, not a rate: below it a single failed render is
 * 33% and would paint the page red on a quiet Tuesday. Background failure (bad uploads,
 * exhausted quality retries) sits in low single digits, so 20% reads as "something is
 * wrong with the model or the key" and 50% as "it is not working".
 */
export const THRESHOLDS = Object.freeze({
  RENDER_MIN_SAMPLE: 20,
  RENDER_DEGRADED_RATIO: 0.2,
  RENDER_DOWN_RATIO: 0.5,
  DB_SLOW_MS: 250,
  STORAGE_SLOW_MS: 1500,
  TOMBSTONE_BACKLOG: 500,
  STRIPE_STUCK_DOWN: 10,
});

/**
 * Every reason a component can carry, with its canonical ENGLISH sentence.
 *
 * The code is what goes on the wire; the sentence is the fallback the browser passes to
 * LanguageSystem.getText('status.components.reason.<CODE>', reason). That ordering is the
 * whole point — translating is purely additive, and a pack that lacks the key degrades to
 * English instead of blank. Same contract as public/scripts/shared/unstageable-message.js.
 *
 * test/i18n/status-components-i18n.test.js blocks the deploy if a code here is missing
 * from any of the 11 packs, because the English fallback would otherwise hide it.
 */
export const HEALTH_REASONS = Object.freeze({
  // app
  APP_SERVING: 'Serving requests normally.',
  APP_INCIDENT_OPEN: 'An incident is open on the service.',
  APP_SATURATED: 'The render queue is at capacity; new API renders are being turned away.',
  // database
  DB_READY: 'Responding to queries.',
  DB_SLOW: 'Responding, but more slowly than usual.',
  DB_CLOSED: 'The database connection is closed.',
  DB_UNREACHABLE: 'The database did not answer.',
  // storage
  STORAGE_READY: 'Image storage is reachable.',
  STORAGE_LOCAL: 'Serving images from local disk.',
  STORAGE_DISABLED: 'Image storage is not configured, so saved renders are unavailable.',
  STORAGE_UNREACHABLE: 'Image storage did not answer.',
  STORAGE_SLOW: 'Image storage is answering slowly.',
  STORAGE_CLEANUP_FAILING: 'Deleted images are not being removed from storage.',
  STORAGE_CLEANUP_BACKLOG: 'A backlog of deleted images is waiting to be removed from storage.',
  // staging
  AI_READY: 'Staging renders are completing normally.',
  AI_NOT_CONFIGURED: 'The staging model is not configured.',
  RENDERS_DEGRADED: 'More staging renders than usual are failing.',
  RENDERS_FAILING: 'Most staging renders are failing.',
  // chat
  CHAT_READY: 'The AI designer is available.',
  CHAT_FALLBACK_ONLY: 'The AI designer is running without its conversation model.',
  CHAT_NOT_CONFIGURED: 'The AI designer is not configured.',
  // billing
  BILLING_READY: 'Checkout and subscriptions are available.',
  BILLING_NOT_CONFIGURED: 'Payments are not configured.',
  BILLING_EVENTS_STUCK: 'Payment events are waiting to be processed.',
  // email
  EMAIL_READY: 'Transactional email is available.',
  EMAIL_NOT_CONFIGURED: 'Transactional email is not configured.',
  // accounts
  ACCOUNTS_READY: 'Sign-in and registration are available.',
  ACCOUNTS_DEGRADED: 'Sign-in may be unavailable while the database is unreachable.',
  OAUTH_NOT_CONFIGURED: 'Sign-in with Google is unavailable.',
  SIGNUP_EMAIL_UNAVAILABLE: 'New registrations cannot be verified while email is unavailable.',
  // Emitted by the runner, never by a rule.
  CHECK_PENDING: 'The first check has not finished yet.',
  CHECK_TIMEOUT: 'The check did not finish in time.',
  CHECK_FAILED: 'The check could not be completed.',
  CHECK_UNAVAILABLE: 'This check is not available on this server.',
});

/** Display order on the page. */
export const COMPONENT_IDS = Object.freeze([
  'app', 'staging', 'chat', 'accounts', 'billing', 'email', 'storage', 'database',
]);

/**
 * Components whose failure means the product does not work. Only a core component can
 * drive `overall` to 'down'; a non-core one caps out at 'degraded', because "you cannot
 * pay us right now" is not the same page as "nothing works".
 */
export const CORE_IDS = Object.freeze(['app', 'staging', 'storage', 'database']);

/** @param {string} reasonCode @param {string} [detail] */
function verdict(state, reasonCode, detail) {
  return detail ? { state, reasonCode, detail } : { state, reasonCode };
}

// ── The rules ───────────────────────────────────────────────────────────────────
//
// Each decide* is PURE over a facts object, evaluated top to bottom, first match wins.
// The ordering inside each is deliberate: configuration → persisted outcome → live
// probe. A component that is not configured can never be judged by its outcome data.

/**
 * @param {{ uptimeState?: string, inFlight?: number|null, concurrencyLimit?: number|null }} f
 */
export function decideApp(f) {
  if (f.uptimeState && f.uptimeState !== 'up') return verdict('degraded', 'APP_INCIDENT_OPEN');
  if (Number.isFinite(f.inFlight) && Number.isFinite(f.concurrencyLimit)
    && Number(f.concurrencyLimit) > 0 && Number(f.inFlight) >= Number(f.concurrencyLimit)) {
    return verdict('degraded', 'APP_SATURATED', `${f.inFlight}/${f.concurrencyLimit} renders in flight`);
  }
  return verdict('operational', 'APP_SERVING');
}

/**
 * @param {{ available?: boolean, open?: boolean, error?: string|null, latencyMs?: number|null }} f
 */
export function decideDatabase(f) {
  if (!f.available) return verdict('unknown', 'CHECK_UNAVAILABLE');
  if (f.open !== true) return verdict('down', 'DB_CLOSED');
  if (f.error) return verdict('down', 'DB_UNREACHABLE', f.error);
  if (Number(f.latencyMs) > THRESHOLDS.DB_SLOW_MS) return verdict('degraded', 'DB_SLOW', `${f.latencyMs} ms`);
  return verdict('operational', 'DB_READY', `${f.latencyMs} ms`);
}

/**
 * A 404 from the probe key is a PASS, not a failure: it proves the bucket authenticated
 * and answered. Only a throw (bad credentials, 5xx, DNS) is a fault, which is why
 * STORAGE_UNREACHABLE keys off the error and not off the null return.
 *
 * The cleanup signals are `degraded`, never `down`: a tombstone backlog means images a
 * user deleted still sit in the bucket — worth surfacing as a privacy commitment, but no
 * visitor experiences it as an outage.
 *
 * @param {{ backend?: string, error?: string|null, timedOut?: boolean, latencyMs?: number|null,
 *   tombstonesFailing?: number, tombstoneBacklog?: number, lastTombstoneError?: string|null }} f
 */
export function decideStorage(f) {
  if (f.backend === 'disabled' || !f.backend) return verdict('down', 'STORAGE_DISABLED');
  if (f.backend === 'local') return verdict('operational', 'STORAGE_LOCAL');
  if (f.error) return verdict('down', 'STORAGE_UNREACHABLE', f.error);
  if (f.timedOut) return verdict('degraded', 'STORAGE_SLOW', 'no answer in time');
  if (Number(f.tombstonesFailing) >= 1) {
    return verdict('degraded', 'STORAGE_CLEANUP_FAILING', f.lastTombstoneError || `${f.tombstonesFailing} failing`);
  }
  if (Number(f.tombstoneBacklog) >= THRESHOLDS.TOMBSTONE_BACKLOG) {
    return verdict('degraded', 'STORAGE_CLEANUP_BACKLOG', `${f.tombstoneBacklog} queued`);
  }
  if (Number(f.latencyMs) > THRESHOLDS.STORAGE_SLOW_MS) return verdict('degraded', 'STORAGE_SLOW', `${f.latencyMs} ms`);
  return verdict('operational', 'STORAGE_READY', `${f.latencyMs} ms`);
}

/**
 * @param {{ configured?: boolean, total7d?: number|null, failed7d?: number|null }} f
 */
export function decideStaging(f) {
  if (!f.configured) return verdict('down', 'AI_NOT_CONFIGURED');
  const total = Number(f.total7d) || 0;
  const failed = Number(f.failed7d) || 0;
  if (total < THRESHOLDS.RENDER_MIN_SAMPLE) return verdict('operational', 'AI_READY');
  const ratio = failed / total;
  const detail = `${failed}/${total} failed in 7d`;
  if (ratio >= THRESHOLDS.RENDER_DOWN_RATIO) return verdict('down', 'RENDERS_FAILING', detail);
  if (ratio >= THRESHOLDS.RENDER_DEGRADED_RATIO) return verdict('degraded', 'RENDERS_DEGRADED', detail);
  return verdict('operational', 'AI_READY', detail);
}

/** @param {{ genAI?: boolean, openai?: boolean }} f */
export function decideChat(f) {
  if (!f.genAI && !f.openai) return verdict('down', 'CHAT_NOT_CONFIGURED');
  if (!f.openai) return verdict('degraded', 'CHAT_FALLBACK_ONLY');
  return verdict('operational', 'CHAT_READY');
}

/** @param {{ configured?: boolean, stuckEvents?: number|null }} f */
export function decideBilling(f) {
  if (!f.configured) return verdict('down', 'BILLING_NOT_CONFIGURED');
  const stuck = Number(f.stuckEvents) || 0;
  if (stuck >= THRESHOLDS.STRIPE_STUCK_DOWN) return verdict('down', 'BILLING_EVENTS_STUCK', `${stuck} stuck`);
  if (stuck >= 1) return verdict('degraded', 'BILLING_EVENTS_STUCK', `${stuck} stuck`);
  return verdict('operational', 'BILLING_READY');
}

/** @param {{ configured?: boolean }} f */
export function decideEmail(f) {
  if (!f.configured) return verdict('down', 'EMAIL_NOT_CONFIGURED');
  return verdict('operational', 'EMAIL_READY');
}

/** @param {{ databaseState?: string, oauth?: boolean, email?: boolean }} f */
export function decideAccounts(f) {
  if (f.databaseState === 'down') return verdict('degraded', 'ACCOUNTS_DEGRADED');
  if (!f.oauth) return verdict('degraded', 'OAUTH_NOT_CONFIGURED');
  if (!f.email) return verdict('degraded', 'SIGNUP_EMAIL_UNAVAILABLE');
  return verdict('operational', 'ACCOUNTS_READY');
}

/**
 * Fold the component list into one headline verdict, beside — never replacing — the
 * heartbeat's own `status`/`currentState`.
 *
 * `unknown` NEVER worsens the result: a probe we could not run is our failure to
 * measure, not the service's failure to run. It is still counted in the summary and
 * rendered as a grey pill, so it is visible without being alarming.
 *
 * @param {{ status?: string } | null | undefined} uptime - The heartbeat snapshot.
 * @param {{ id: string, core?: boolean, state: string }[]} components
 * @returns {{ overall: 'operational'|'degraded'|'down', componentsSummary: object }}
 */
export function rollUp(uptime, components) {
  const list = Array.isArray(components) ? components : [];
  const summary = { operational: 0, degraded: 0, down: 0, unknown: 0, worst: 'operational' };
  let coreDown = false;
  let anyDown = false;
  let anyDegraded = false;

  for (const c of list) {
    if (c.state === 'down') {
      summary.down += 1;
      anyDown = true;
      if (c.core) coreDown = true;
    } else if (c.state === 'degraded') {
      summary.degraded += 1;
      anyDegraded = true;
    } else if (c.state === 'unknown') {
      summary.unknown += 1;
    } else {
      summary.operational += 1;
    }
  }

  let overall = /** @type {'operational'|'degraded'|'down'} */ ('operational');
  if (coreDown) overall = 'down';
  else if (anyDown || anyDegraded) overall = 'degraded';
  else if (uptime && uptime.status === 'degraded') overall = 'degraded';

  summary.worst = overall;
  return { overall, componentsSummary: summary };
}

/** Shape a decide* verdict into the object that goes on the wire. */
function shape(id, v, extra = {}) {
  return {
    id,
    core: CORE_IDS.includes(id),
    state: v.state,
    reasonCode: v.reasonCode,
    reason: HEALTH_REASONS[v.reasonCode] || '',
    ...(v.detail ? { detail: v.detail } : {}),
    ...extra,
  };
}

/** The pre-warm section: what callers see in the window before the first refresh lands. */
function pendingComponents() {
  return COMPONENT_IDS.filter((id) => id !== 'app')
    .map((id) => shape(id, verdict('unknown', 'CHECK_PENDING')));
}

/**
 * Resolve (never reject) to `fallback` if `promise` has not settled within `ms`.
 * The timer is unref'd, and note what this does NOT do: `objectStore.head` has no abort
 * signal, so this bounds how long we wait, not how long the request runs.
 * @template T @param {Promise<T>} promise @param {number} ms @param {T} fallback
 */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); resolve({ ...fallback, error: err && err.message ? err.message : String(err) }); },
    );
  });
}

/**
 * Build the health runner.
 *
 * EVERY dep is optional and absent-tolerant — the specs and test helpers build partial
 * bags, and a missing dep must yield `unknown`, never a crash.
 *
 * @param {{
 *   getDb?: () => any,
 *   objectStore?: { backend?: string, head?: (key: string) => Promise<any> } | null,
 *   genAI?: unknown, openai?: unknown, stripe?: unknown, resend?: unknown,
 *   googleOAuthClient?: unknown,
 *   getHealthCounters?: () => any,
 *   getInFlight?: () => number,
 *   concurrencyLimit?: number,
 *   intervalMs?: number,
 *   timeouts?: { storage?: number, refresh?: number },
 *   now?: () => number,
 * }} deps
 */
export function createServiceHealth(deps = {}) {
  const {
    getDb, objectStore, genAI, openai, stripe, resend, googleOAuthClient,
    getHealthCounters, getInFlight, concurrencyLimit,
  } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const TIMEOUT = { ...DEFAULT_TIMEOUT, ...(deps.timeouts || {}) };
  const intervalMs = Number.isFinite(deps.intervalMs) ? Number(deps.intervalMs) : 60_000;

  /**
   * The key we HEAD against R2.
   *
   * It has to satisfy lib/data/object-keys.js's gate-1 regex — the store refuses any
   * other shape BEFORE it reaches the network, so a made-up `health/probe` would report
   * the bucket unreachable on a perfectly healthy deployment. An all-zero render id is
   * the right shape and is never minted (render ids come from a CSPRNG), so the 404 this
   * gets is guaranteed and is the expected pass.
   */
  const PROBE_KEY = STORAGE_PROBE_KEY;

  /** @type {{ components: any[], checkedAt: number } | null} */
  let cache = null;
  /** @type {Promise<any> | null} */
  let pending = null;
  /** @type {any} */
  let timer = null;
  /** @type {Map<string, { at: number, value: any }>} */
  const memo = new Map();
  /** Last reason code per component, so a broken bucket logs once and not every 30 s. */
  const lastCodes = new Map();

  /** @param {string} key @param {number} ttl @param {() => Promise<any>} fn */
  async function cached(key, ttl, fn) {
    const hit = memo.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = await fn();
    memo.set(key, { at: now(), value });
    return value;
  }

  async function probeDb() {
    if (typeof getDb !== 'function') return { available: false };
    return cached('db', TTL.db, async () => {
      const started = Date.now();
      try {
        const db = getDb();
        if (!db || db.open !== true) return { available: true, open: false };
        db.prepare('SELECT 1').get();
        return { available: true, open: true, latencyMs: Date.now() - started };
      } catch (err) {
        return { available: true, open: true, error: err && err.message ? err.message : String(err) };
      }
    });
  }

  async function probeStorage() {
    const store = /** @type {any} */ (objectStore);
    const backend = store && store.backend ? store.backend : 'disabled';
    if (backend !== 'r2' || typeof store.head !== 'function') return { backend };
    const head = store.head.bind(store);
    return cached('storage', TTL.storage, async () => {
      const started = Date.now();
      // A 404 resolves to null and is a PASS; only a throw is a fault. The catch is
      // inside the raced promise so a rejection can never surface as a timeout.
      const probe = Promise.resolve()
        .then(() => head(PROBE_KEY))
        .then(() => /** @type {any} */ ({ backend }))
        .catch((err) => /** @type {any} */ ({ backend, error: err && err.message ? err.message : String(err) }));
      const result = await withTimeout(probe, TIMEOUT.storage, /** @type {any} */ ({ backend, timedOut: true }));
      return { ...result, latencyMs: Date.now() - started };
    });
  }

  async function readCounters() {
    if (typeof getHealthCounters !== 'function') return null;
    return cached('counters', TTL.counters, async () => {
      try {
        return getHealthCounters();
      } catch (err) {
        logger.warn('[health] counters unavailable: ' + (err && err.message ? err.message : err));
        return null;
      }
    });
  }

  /** Note a state change once, rather than every refresh. */
  function noteTransition(c) {
    const prev = lastCodes.get(c.id);
    if (prev === c.reasonCode) return;
    lastCodes.set(c.id, c.reasonCode);
    if (prev === undefined) return;
    const line = `[health] ${c.id} → ${c.state} (${c.reasonCode})${c.detail ? ': ' + c.detail : ''}`;
    if (c.state === 'operational') logger.info(line);
    else logger.warn(line);
  }

  async function compute() {
    const [db, storage, counters] = await Promise.all([
      probeDb().catch((err) => ({ available: true, open: true, error: String(err && err.message || err) })),
      probeStorage().catch((err) => ({ backend: 'r2', error: String(err && err.message || err) })),
      readCounters().catch(() => null),
    ]);

    const dbV = decideDatabase(db);
    const components = [
      shape('staging', decideStaging({
        configured: !!genAI,
        total7d: counters && counters.renders7d ? counters.renders7d.total : null,
        failed7d: counters && counters.renders7d ? counters.renders7d.failed : null,
      })),
      shape('chat', decideChat({ genAI: !!genAI, openai: !!openai })),
      shape('accounts', decideAccounts({
        databaseState: dbV.state, oauth: !!googleOAuthClient, email: !!resend,
      })),
      shape('billing', decideBilling({
        configured: !!stripe,
        stuckEvents: counters ? counters.stuckStripeEvents : 0,
      })),
      shape('email', decideEmail({ configured: !!resend })),
      shape('storage', decideStorage({
        ...storage,
        tombstonesFailing: counters ? counters.tombstonesFailing : 0,
        tombstoneBacklog: counters ? counters.tombstoneBacklog : 0,
        lastTombstoneError: counters ? counters.lastTombstoneError : null,
      }), storage.latencyMs != null ? { latencyMs: storage.latencyMs } : {}),
      shape('database', dbV, db.latencyMs != null ? { latencyMs: db.latencyMs } : {}),
    ];

    for (const c of components) noteTransition(c);
    cache = { components, checkedAt: now() };
    return cache;
  }

  function refresh() {
    if (pending) return pending;
    // compute() is built so it cannot reject, but a refresh must never be the thing that
    // takes the status page down, so the catch stays: it falls back to the last section.
    const work = compute().catch((err) => {
      logger.warn('[health] refresh failed: ' + (err && err.message ? err.message : err));
      return cache;
    });
    pending = withTimeout(work, TIMEOUT.refresh, null)
      .then((res) => res || cache)
      .finally(() => { pending = null; });
    return pending;
  }

  /**
   * The read path. SYNCHRONOUS and probe-free by design: /api/status is polled by every
   * visitor on a 60 s timer, so a burst of pollers must cost zero probes. A stale entry
   * is served as-is with `stale: true` while a refresh runs behind it.
   *
   * `app` is decided HERE rather than cached, because it is free and because the open
   * incident it reports must be current, not up to 30 seconds old.
   *
   * @param {{ uptime?: any, includeDetail?: boolean }} [opts] - `includeDetail` is
   *   admin-only: `detail` is the one field that can carry an R2 error body or a SQLite
   *   message, and that is infrastructure the public page must never publish.
   */
  function getSection(opts = {}) {
    const { uptime = null, includeDetail = false } = opts;
    const t = now();
    let stale = false;
    /** @type {any[]} */
    let list;
    if (!cache) {
      list = pendingComponents();
      void refresh();
    } else {
      stale = t - cache.checkedAt >= CACHE_MS;
      if (stale) void refresh();
      list = cache.components;
    }

    const app = shape('app', decideApp({
      uptimeState: uptime ? uptime.currentState : undefined,
      inFlight: typeof getInFlight === 'function' ? getInFlight() : null,
      concurrencyLimit: concurrencyLimit ?? null,
    }), { checkedAt: t });

    const components = [app, ...list.map((c) => ({ ...c, checkedAt: cache ? cache.checkedAt : t, stale }))]
      .map((c) => {
        if (includeDetail) return c;
        const { detail: _detail, ...rest } = c;
        return rest;
      });

    // Keep the wire order stable regardless of how the list was assembled.
    components.sort((a, b) => COMPONENT_IDS.indexOf(a.id) - COMPONENT_IDS.indexOf(b.id));
    return { components, checkedAt: cache ? cache.checkedAt : null, stale };
  }

  function start() {
    if (timer) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { getSection, refresh, start, stop };
}

/**
 * The composed status payload: the heartbeat snapshot with the component section
 * folded in beside it.
 *
 * Both routes call this rather than spelling the merge out twice, because the ONE rule
 * that must not drift between them is which fields are additive: `status` and
 * `currentState` keep the heartbeat's meaning, and everything here is new alongside.
 *
 * @param {any} snapshot - uptimeMonitor.getSnapshot() or getAdminSnapshot().
 * @param {{ getSection: Function } | null | undefined} serviceHealth - Optional: absent,
 *   the snapshot is returned untouched, which is exactly the payload both routes served
 *   before components existed.
 * @param {{ includeDetail?: boolean }} [opts]
 */
export function statusPayload(snapshot, serviceHealth, opts = {}) {
  if (!serviceHealth) return snapshot;
  const includeDetail = !!opts.includeDetail;
  const section = serviceHealth.getSection({ uptime: snapshot, includeDetail });
  return {
    ...snapshot,
    ...rollUp(snapshot, section.components),
    components: section.components,
    componentsCheckedAt: section.checkedAt,
    ...(includeDetail ? { componentsStale: section.stale } : {}),
  };
}

/**
 * The flat booleans /health reports beside `status` and `aiConfigured`.
 *
 * PROPERTY READS ONLY — no probe, no cache, nothing that can block. /health is what an
 * external monitor polls every 30 seconds; the probing view of the same question is
 * /api/status. `getDb` is called in a try/catch because "the database could not even be
 * opened" has to answer `false`, not throw out of a health check.
 *
 * @param {{ getDb?: () => any, objectStore?: any, openai?: unknown, stripe?: unknown,
 *   resend?: unknown, googleOAuthClient?: unknown }} deps
 */
export function healthFlags(deps = {}) {
  let dbOpen;
  try {
    dbOpen = typeof deps.getDb === 'function' && deps.getDb().open === true;
  } catch {
    dbOpen = false;
  }
  return {
    uptimeSeconds: Math.round(process.uptime()),
    dbOpen,
    storageBackend: deps.objectStore ? deps.objectStore.backend : 'disabled',
    storageConfigured: !!(deps.objectStore && deps.objectStore.configured),
    chatConfigured: !!deps.openai,
    billingConfigured: !!deps.stripe,
    emailConfigured: !!deps.resend,
    oauthConfigured: !!deps.googleOAuthClient,
  };
}
