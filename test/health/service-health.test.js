// The per-component decision table (lib/health/service-health.js), pinned at its
// boundaries. Every threshold in THRESHOLDS is a judgement call about when a page goes
// amber for real users, so each one is tested on both sides of the line rather than
// somewhere comfortably inside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_REASONS, COMPONENT_IDS, CORE_IDS, THRESHOLDS,
  decideApp, decideDatabase, decideStorage, decideStaging,
  decideChat, decideBilling, decideEmail, decideAccounts, rollUp, STORAGE_PROBE_KEY,
} from '../../lib/health/service-health.js';
import { isSafeObjectKey } from '../../lib/data/object-keys.js';

test('every reason code a rule can emit has English copy', () => {
  // The browser falls back to this string when a pack lacks the key, so a code with no
  // entry here ships as an empty line on a public page.
  const emitted = [
    decideApp({}), decideApp({ uptimeState: 'down' }), decideApp({ inFlight: 3, concurrencyLimit: 3 }),
    decideDatabase({}), decideDatabase({ available: true, open: false }),
    decideDatabase({ available: true, open: true, error: 'x' }),
    decideDatabase({ available: true, open: true, latencyMs: 9999 }),
    decideDatabase({ available: true, open: true, latencyMs: 1 }),
    decideStorage({}), decideStorage({ backend: 'local' }), decideStorage({ backend: 'r2', error: 'x' }),
    decideStorage({ backend: 'r2', timedOut: true }),
    decideStorage({ backend: 'r2', tombstonesFailing: 2 }),
    decideStorage({ backend: 'r2', tombstoneBacklog: 999 }),
    decideStorage({ backend: 'r2', latencyMs: 99999 }), decideStorage({ backend: 'r2', latencyMs: 5 }),
    decideStaging({}), decideStaging({ configured: true }),
    decideStaging({ configured: true, total7d: 100, failed7d: 30 }),
    decideStaging({ configured: true, total7d: 100, failed7d: 80 }),
    decideChat({}), decideChat({ genAI: true }), decideChat({ genAI: true, openai: true }),
    decideBilling({}), decideBilling({ configured: true }),
    decideBilling({ configured: true, stuckEvents: 1 }),
    decideBilling({ configured: true, stuckEvents: 50 }),
    decideEmail({}), decideEmail({ configured: true }),
    decideAccounts({ databaseState: 'down' }), decideAccounts({}),
    decideAccounts({ oauth: true }), decideAccounts({ oauth: true, email: true }),
  ];
  for (const v of emitted) {
    assert.equal(typeof HEALTH_REASONS[v.reasonCode], 'string', `no copy for ${v.reasonCode}`);
    assert.ok(HEALTH_REASONS[v.reasonCode].trim().length > 0, `empty copy for ${v.reasonCode}`);
  }
});

test('the storage probe key passes the object store’s own key gate', () => {
  // The store refuses an unrecognised key shape BEFORE any network call, so a probe key
  // that fails gate 1 would report every healthy bucket as unreachable. This caught
  // exactly that: the first version used `health/probe`, which is not a valid key.
  assert.ok(isSafeObjectKey(STORAGE_PROBE_KEY), `${STORAGE_PROBE_KEY} would be refused before it left the process`);
});

test('core ids are all real component ids', () => {
  for (const id of CORE_IDS) assert.ok(COMPONENT_IDS.includes(id), `${id} is not a component`);
});

test('app reports an open incident and a saturated render queue', () => {
  assert.deepEqual(decideApp({ uptimeState: 'up' }), { state: 'operational', reasonCode: 'APP_SERVING' });
  assert.equal(decideApp({ uptimeState: 'down' }).reasonCode, 'APP_INCIDENT_OPEN');
  assert.equal(decideApp({ uptimeState: 'down' }).state, 'degraded');
  // At the ceiling, not merely near it.
  assert.equal(decideApp({ uptimeState: 'up', inFlight: 11, concurrencyLimit: 12 }).state, 'operational');
  assert.equal(decideApp({ uptimeState: 'up', inFlight: 12, concurrencyLimit: 12 }).reasonCode, 'APP_SATURATED');
  // No gauge wired: never guess.
  assert.equal(decideApp({ uptimeState: 'up', inFlight: null, concurrencyLimit: null }).state, 'operational');
});

test('database: missing dep is unknown, closed is down, slow is degraded', () => {
  assert.equal(decideDatabase({}).state, 'unknown');
  assert.equal(decideDatabase({}).reasonCode, 'CHECK_UNAVAILABLE');
  assert.equal(decideDatabase({ available: true, open: false }).state, 'down');
  const err = decideDatabase({ available: true, open: true, error: 'disk I/O error' });
  assert.equal(err.reasonCode, 'DB_UNREACHABLE');
  assert.equal(err.detail, 'disk I/O error');
  const at = THRESHOLDS.DB_SLOW_MS;
  assert.equal(decideDatabase({ available: true, open: true, latencyMs: at }).state, 'operational');
  assert.equal(decideDatabase({ available: true, open: true, latencyMs: at + 1 }).state, 'degraded');
});

test('storage: a 404 probe is a pass, a throw is not', () => {
  // The probe key is never written, so head() resolving null (404) is the expected
  // success — it proves the bucket authenticated and answered.
  assert.equal(decideStorage({ backend: 'r2', latencyMs: 40 }).state, 'operational');
  assert.equal(decideStorage({ backend: 'r2', error: 'HTTP 403' }).state, 'down');
  assert.equal(decideStorage({ backend: 'r2', error: 'HTTP 403' }).reasonCode, 'STORAGE_UNREACHABLE');
  assert.equal(decideStorage({ backend: 'r2', timedOut: true }).state, 'degraded');
  assert.equal(decideStorage({ backend: 'disabled' }).reasonCode, 'STORAGE_DISABLED');
  assert.equal(decideStorage({}).reasonCode, 'STORAGE_DISABLED');
  assert.equal(decideStorage({ backend: 'local' }).state, 'operational');
});

test('storage: cleanup problems are degraded, never down', () => {
  const failing = decideStorage({ backend: 'r2', tombstonesFailing: 1, lastTombstoneError: 'AccessDenied' });
  assert.equal(failing.state, 'degraded');
  assert.equal(failing.reasonCode, 'STORAGE_CLEANUP_FAILING');
  assert.equal(failing.detail, 'AccessDenied');
  assert.equal(decideStorage({ backend: 'r2', tombstonesFailing: 0, latencyMs: 5 }).state, 'operational');

  const n = THRESHOLDS.TOMBSTONE_BACKLOG;
  assert.equal(decideStorage({ backend: 'r2', tombstoneBacklog: n - 1, latencyMs: 5 }).state, 'operational');
  assert.equal(decideStorage({ backend: 'r2', tombstoneBacklog: n }).reasonCode, 'STORAGE_CLEANUP_BACKLOG');

  const slow = THRESHOLDS.STORAGE_SLOW_MS;
  assert.equal(decideStorage({ backend: 'r2', latencyMs: slow }).state, 'operational');
  assert.equal(decideStorage({ backend: 'r2', latencyMs: slow + 1 }).reasonCode, 'STORAGE_SLOW');
});

test('staging: the failure ratio only applies above the sample floor', () => {
  const min = THRESHOLDS.RENDER_MIN_SAMPLE;
  assert.equal(decideStaging({ configured: false }).state, 'down');
  assert.equal(decideStaging({ configured: false }).reasonCode, 'AI_NOT_CONFIGURED');
  // Below the floor a quiet day with every render failing is still operational: one
  // failure out of three is 33% and must not paint the page red.
  assert.equal(decideStaging({ configured: true, total7d: min - 1, failed7d: min - 1 }).state, 'operational');
  // No counters at all (a server without the metrics dep) is not evidence of failure.
  assert.equal(decideStaging({ configured: true, total7d: null, failed7d: null }).state, 'operational');

  const ratios = [
    [0.19, 'operational'], [0.2, 'degraded'], [0.49, 'degraded'], [0.5, 'down'],
  ];
  for (const [ratio, expected] of ratios) {
    const total = 100;
    const got = decideStaging({ configured: true, total7d: total, failed7d: Math.round(ratio * total) });
    assert.equal(got.state, expected, `${ratio} should be ${expected}, got ${got.state}`);
  }
  assert.equal(decideStaging({ configured: true, total7d: 100, failed7d: 25 }).detail, '25/100 failed in 7d');
});

test('chat degrades to fallback-only without the conversation model', () => {
  assert.equal(decideChat({ genAI: false, openai: false }).state, 'down');
  assert.equal(decideChat({ genAI: true, openai: false }).reasonCode, 'CHAT_FALLBACK_ONLY');
  assert.equal(decideChat({ genAI: true, openai: true }).state, 'operational');
});

test('billing: one stuck event is a warning, ten is an outage', () => {
  assert.equal(decideBilling({ configured: false }).state, 'down');
  assert.equal(decideBilling({ configured: true, stuckEvents: 0 }).state, 'operational');
  assert.equal(decideBilling({ configured: true, stuckEvents: 1 }).state, 'degraded');
  assert.equal(decideBilling({ configured: true, stuckEvents: THRESHOLDS.STRIPE_STUCK_DOWN - 1 }).state, 'degraded');
  assert.equal(decideBilling({ configured: true, stuckEvents: THRESHOLDS.STRIPE_STUCK_DOWN }).state, 'down');
});

test('accounts follows the database and its two sign-in paths', () => {
  assert.equal(decideAccounts({ databaseState: 'down', oauth: true, email: true }).reasonCode, 'ACCOUNTS_DEGRADED');
  assert.equal(decideAccounts({ databaseState: 'operational', oauth: false, email: true }).reasonCode, 'OAUTH_NOT_CONFIGURED');
  assert.equal(decideAccounts({ databaseState: 'operational', oauth: true, email: false }).reasonCode, 'SIGNUP_EMAIL_UNAVAILABLE');
  assert.equal(decideAccounts({ databaseState: 'operational', oauth: true, email: true }).state, 'operational');
  assert.equal(decideEmail({ configured: true }).state, 'operational');
});

// ── rollUp ──────────────────────────────────────────────────────────────────────

const comp = (id, state, core = false) => ({ id, state, core });

test('only a core component can drive overall down', () => {
  assert.equal(rollUp(null, [comp('staging', 'down', true)]).overall, 'down');
  assert.equal(rollUp(null, [comp('billing', 'down', false)]).overall, 'degraded');
  assert.equal(rollUp(null, [comp('email', 'degraded')]).overall, 'degraded');
  assert.equal(rollUp(null, [comp('app', 'operational', true)]).overall, 'operational');
});

test('unknown never worsens overall but is still counted', () => {
  const { overall, componentsSummary } = rollUp(null, [
    comp('app', 'operational', true), comp('database', 'unknown', true), comp('email', 'operational'),
  ]);
  assert.equal(overall, 'operational');
  assert.equal(componentsSummary.unknown, 1);
  assert.equal(componentsSummary.operational, 2);
  assert.equal(componentsSummary.worst, 'operational');
});

test('an open heartbeat incident still degrades overall on its own', () => {
  assert.equal(rollUp({ status: 'degraded' }, [comp('app', 'operational', true)]).overall, 'degraded');
  assert.equal(rollUp({ status: 'operational' }, [comp('app', 'operational', true)]).overall, 'operational');
  assert.equal(rollUp(undefined, []).overall, 'operational');
});
