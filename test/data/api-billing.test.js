// Tier: unit (real SQLite, temp data dir) — lib/data/api-billing.js.
//
// WHAT THIS COVERS
// The prepaid-credit store: every path where money moves. This is the spec that
// has to be right before anything above it is written, because every failure here
// is either a free render or a customer charged for an image they never got.
//   - the debit barrier is the SQL, so spending at exactly `balance` works and one
//     credit beyond it writes NOTHING (no ledger row, no balance change, no claim),
//   - `balance === SUM(delta)` survives a randomized sequence of every operation —
//     the ledger is the source of truth and the balance is only a cache of it,
//   - a refund is idempotent (both settle paths in api-render-billing.js can and do
//     call it) and refunding a delivered render is refused,
//   - a purchase is idempotent per Stripe session id, and the partial UNIQUE index
//     that backstops it genuinely exists on disk,
//   - clawback clamps at zero, records the shortfall and suspends the account, and
//   - the idempotency-key state machine: replay, in-flight, reclaim-after-abandon,
//     the attempt ceiling, and a key reused for different parameters.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb } from '../../lib/data/db.js';
import {
  createApiBilling,
  REQUEST_RECLAIM_MS,
  MAX_REPLAY_ATTEMPTS,
} from '../../lib/data/api-billing.js';

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-api-billing-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  // Release the shared connection first — Windows won't unlink an open .db/-wal/-shm.
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try { closeDb(d); } catch { /* already closed */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function fakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const USER = 'user_1';
const KEY = 'ak_1';

/** Claim + debit with sensible defaults, so each test names only what it varies. */
function claim(billing, over = {}) {
  return billing.claimAndDebit({
    keyId: KEY,
    userId: USER,
    idempotencyKey: 'idem_1',
    fingerprint: 'fp_1',
    cost: 1,
    ...over,
  });
}

test('a fresh account starts at zero and cannot render', () => {
  const billing = createApiBilling(tempDir());
  assert.equal(billing.getBalance(USER).balance, 0);

  const out = claim(billing);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'insufficient');
  assert.equal(out.balance, 0);
});

test('the debit barrier is the SQL: spending the last credit works, one more writes nothing', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 2 });

  assert.equal(claim(billing, { idempotencyKey: 'a' }).ok, true);
  const last = claim(billing, { idempotencyKey: 'b' });
  assert.equal(last.ok, true, 'spending down to exactly zero is allowed');
  assert.equal(last.balance, 0);

  const ledgerBefore = billing.listLedger(USER).length;
  const overdraft = claim(billing, { idempotencyKey: 'c' });

  assert.equal(overdraft.ok, false);
  assert.equal(overdraft.reason, 'insufficient');
  assert.equal(billing.getBalance(USER).balance, 0, 'the balance must never go negative');
  assert.equal(
    billing.listLedger(USER).length,
    ledgerBefore,
    'a refused debit must not leave a ledger row behind',
  );
});

test('a refused debit releases its idempotency key so a retry after topping up works', () => {
  const billing = createApiBilling(tempDir());
  const refused = claim(billing, { idempotencyKey: 'same' });
  assert.equal(refused.ok, false);

  billing.grantCredits({ userId: USER, credits: 1 });
  const retry = claim(billing, { idempotencyKey: 'same' });
  assert.equal(retry.ok, true, 'the failed claim must not burn the key');
});

test('the ledger is the source of truth: balance === SUM(delta) across a randomized sequence', () => {
  const billing = createApiBilling(tempDir());
  // Deterministic PRNG — Math.random would make a failure unreproducible.
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  billing.creditPurchase({ userId: USER, credits: 40, sessionId: 'cs_seed' });
  const live = [];

  for (let i = 0; i < 200; i += 1) {
    const roll = rnd(4);
    if (roll === 0) {
      billing.creditPurchase({ userId: USER, credits: 1 + rnd(5), sessionId: 'cs_' + i });
    } else if (roll === 1) {
      const out = claim(billing, { idempotencyKey: 'k_' + i, fingerprint: 'f_' + i });
      if (out.ok && out.requestId) live.push(out.requestId);
    } else if (roll === 2 && live.length) {
      billing.refundRequest(live.splice(rnd(live.length), 1)[0]);
    } else if (roll === 3 && live.length) {
      billing.markSucceeded(live.splice(rnd(live.length), 1)[0]);
    }
  }

  const balance = billing.getBalance(USER).balance;
  assert.equal(balance, billing.ledgerSum(USER), 'the cache disagreed with the ledger');
  assert.ok(balance >= 0, 'the balance went negative');
});

test('a refund is idempotent — two settle paths, one credit back', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 5 });
  const { requestId } = claim(billing);
  const after = billing.getBalance(USER).balance;

  const first = billing.refundRequest(requestId);
  assert.equal(first.ok, true);
  assert.equal(first.credited, 1);

  const second = billing.refundRequest(requestId);
  assert.equal(second.ok, false, 'the second settle path must be a no-op');
  assert.equal(second.credited, 0);
  assert.equal(billing.getBalance(USER).balance, after + 1, 'refunded exactly once');
  assert.equal(
    billing.listLedger(USER).filter((r) => r.reason === 'refund').length,
    1,
    'exactly one refund row',
  );
});

test('a delivered render cannot be refunded', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 5 });
  const { requestId } = claim(billing);
  assert.equal(billing.markSucceeded(requestId), true);

  const out = billing.refundRequest(requestId);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not_refundable');
  assert.equal(billing.getBalance(USER).balance, 4, 'a delivered image stays paid for');
});

test('markSucceeded records the realized cost, so cost-per-credit is answerable later', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 2 });
  const { requestId } = claim(billing);
  billing.markSucceeded(requestId, { generations: 1, model: 'fast' });

  const row = billing.getRequest(requestId);
  assert.equal(row.status, 'succeeded');
  assert.deepEqual(JSON.parse(row.extra_json), { generations: 1, model: 'fast' });
});

test('a purchase credits exactly once per Stripe session, however many times it is delivered', () => {
  const billing = createApiBilling(tempDir());
  const first = billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_x', packId: 'api_100' });
  assert.equal(first.credited, 100);

  const redelivery = billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_x' });
  assert.equal(redelivery.duplicate, true);
  assert.equal(redelivery.credited, 0);
  assert.equal(billing.getBalance(USER).balance, 100, 'a webhook redelivery must not double-credit');
  assert.equal(billing.getBalance(USER).lifetimePurchased, 100);
});

test('the partial UNIQUE index that backstops the duplicate check exists on disk', () => {
  const dir = tempDir();
  createApiBilling(dir);
  const db = getDb(dir);
  const indexes = db.prepare("PRAGMA index_list('api_credit_ledger')").all();
  const ext = indexes.find((i) => i.name === 'idx_api_ledger_ext');
  assert.ok(ext, 'idx_api_ledger_ext is missing — nothing structurally prevents a double credit');
  assert.equal(ext.unique, 1, 'the index must be UNIQUE to be a guard at all');

  // And it must actually bite: two 'purchase' rows for one session id cannot coexist.
  const insert = () =>
    db
      .prepare(
        `INSERT INTO api_credit_ledger (id, user_id, delta, reason, external_id, balance_after, created_at)
         VALUES (?, ?, 1, 'purchase', 'cs_dupe', 0, 0)`,
      )
      .run(Math.random().toString(36).slice(2), USER);
  insert();
  assert.throws(insert, /UNIQUE/i, 'the index is present but not enforcing');
});

test('clawback clamps at zero, records the shortfall and suspends the account', () => {
  const billing = createApiBilling(tempDir());
  billing.creditPurchase({ userId: USER, credits: 10, sessionId: 'cs_cb' });
  // Spend most of it, then charge back the whole purchase.
  for (let i = 0; i < 8; i += 1) {
    const out = claim(billing, { idempotencyKey: 'spend_' + i, fingerprint: 'f' + i });
    billing.markSucceeded(out.requestId);
  }

  const out = billing.clawbackCredits({ userId: USER, credits: 10, externalId: 'ch_1' });
  assert.equal(out.clawed, 2, 'takes back only what is left');
  assert.equal(out.shortfall, 8);
  assert.equal(out.suspended, true);
  assert.equal(billing.getBalance(USER).balance, 0, 'never negative');
  assert.ok(billing.getBalance(USER).suspendedAt, 'spend-then-chargeback must suspend');

  // And a suspended account cannot spend even if credits arrive later.
  billing.grantCredits({ userId: USER, credits: 5 });
  const blocked = claim(billing, { idempotencyKey: 'after' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'suspended');
});

test('a clawback is idempotent per charge id', () => {
  const billing = createApiBilling(tempDir());
  billing.creditPurchase({ userId: USER, credits: 10, sessionId: 'cs_y' });
  billing.clawbackCredits({ userId: USER, credits: 4, externalId: 'ch_2' });
  const again = billing.clawbackCredits({ userId: USER, credits: 4, externalId: 'ch_2' });
  assert.equal(again.duplicate, true);
  assert.equal(billing.getBalance(USER).balance, 6, 'clawed exactly once');
});

test('replaying a succeeded request returns the stored outcome without charging again', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 5 });
  const first = claim(billing);
  billing.markSucceeded(first.requestId);
  const balance = billing.getBalance(USER).balance;

  const replay = claim(billing);
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.requestId, first.requestId);
  assert.equal(billing.getBalance(USER).balance, balance, 'a replay must not debit');
});

test('a second call while the first is still rendering is refused as in flight', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 5 });
  claim(billing);

  const concurrent = claim(billing);
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.reason, 'in_flight');
  assert.equal(billing.getBalance(USER).balance, 4, 'only the first attempt paid');
});

test('a claim abandoned mid-render is re-runnable after the window, without a second debit', () => {
  const clock = fakeClock();
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.grantCredits({ userId: USER, credits: 5 });
  claim(billing);
  const balance = billing.getBalance(USER).balance;

  clock.advance(REQUEST_RECLAIM_MS + 1);
  const retry = claim(billing);
  assert.equal(retry.ok, true);
  assert.equal(retry.reclaimed, true);
  assert.equal(
    billing.getBalance(USER).balance,
    balance,
    'they already paid for an image they never received',
  );
});

test('reclaiming is bounded, so a key that always dies is not an unlimited free render', () => {
  const clock = fakeClock();
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.grantCredits({ userId: USER, credits: 5 });
  claim(billing);

  for (let i = 1; i < MAX_REPLAY_ATTEMPTS; i += 1) {
    clock.advance(REQUEST_RECLAIM_MS + 1);
    assert.equal(claim(billing).ok, true, `attempt ${i + 1} should still be allowed`);
  }

  clock.advance(REQUEST_RECLAIM_MS + 1);
  const out = claim(billing);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'too_many_attempts');
});

test('an idempotency key reused for different parameters is refused, not answered with the old image', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 5 });
  const first = claim(billing, { fingerprint: 'living-room' });
  billing.markSucceeded(first.requestId);

  const reused = claim(billing, { fingerprint: 'bedroom' });
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, 'key_reused');
});

test('a refunded request treats the same key as new work rather than replaying it', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 5 });
  const first = claim(billing);
  billing.refundRequest(first.requestId);

  const out = claim(billing);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'settled_retry', 'the money went back, so this key is spent');
});

test('two accounts cannot spend each other\'s credits', () => {
  const billing = createApiBilling(tempDir());
  billing.grantCredits({ userId: USER, credits: 3 });

  const other = billing.claimAndDebit({
    keyId: 'ak_other',
    userId: 'user_2',
    idempotencyKey: 'x',
    fingerprint: 'f',
    cost: 1,
  });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'insufficient');
  assert.equal(billing.getBalance(USER).balance, 3, 'the funded account was untouched');
});

test('the store survives a reopen — it is on disk, not in memory', () => {
  const dir = tempDir();
  const first = createApiBilling(dir);
  first.creditPurchase({ userId: USER, credits: 7, sessionId: 'cs_persist' });
  closeDb(dir);

  const reopened = createApiBilling(dir);
  assert.equal(reopened.getBalance(USER).balance, 7);
  assert.equal(
    reopened.creditPurchase({ userId: USER, credits: 7, sessionId: 'cs_persist' }).duplicate,
    true,
    'idempotency must outlive a restart',
  );
});

// ── usageSummary: what the dashboard's detail panes are made of ──────────────
//
// This is the ONLY read in this module that answers a question about traffic rather
// than about money, and the two are easy to conflate: the ledger knows what was spent
// but not which key spent it, while `api_requests` knows both and knows nothing about
// purchases. Everything below is about keeping that line straight — plus the one thing
// SQLite cannot do cheaply (a median) being honest about its sample.

const DAY_MS = 24 * 60 * 60 * 1000;
// Midday UTC, so a test can move by hours without silently crossing a bucket boundary.
const NOON = Date.UTC(2026, 7, 18, 12, 0, 0);

/**
 * Claim, wait, and settle one request — the shape every row in api_requests has.
 * @param {any} billing - The store.
 * @param {any} clock - The fake clock.
 * @param {{ keyId?: string, idem: string, tookMs?: number, outcome?: 'succeeded' | 'refunded' | 'charged' }} opts - What to record.
 * @returns {string} The request id.
 */
function render(billing, clock, opts) {
  const claimed = claim(billing, {
    keyId: opts.keyId || KEY,
    idempotencyKey: opts.idem,
    fingerprint: 'fp_' + opts.idem,
  });
  assert.ok(claimed.ok, `claim ${opts.idem} was refused: ${claimed.reason}`);
  clock.advance(opts.tookMs ?? 15_000);
  if (opts.outcome === 'refunded') billing.refundRequest(claimed.requestId);
  else if (opts.outcome !== 'charged') billing.markSucceeded(claimed.requestId);
  return claimed.requestId;
}

test('usage buckets one row per UTC day, zero-filled, oldest first', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u1' });

  render(billing, clock, { idem: 'a' });
  clock.advance(2 * DAY_MS);
  render(billing, clock, { idem: 'b' });

  const usage = billing.usageSummary(USER, { days: 30 });
  assert.equal(usage.buckets.length, 30, 'every day in the window gets a bucket, traffic or not');
  assert.ok(usage.buckets[0].day < usage.buckets[29].day, 'oldest first');
  for (let i = 1; i < usage.buckets.length; i++) {
    assert.equal(usage.buckets[i].day - usage.buckets[i - 1].day, DAY_MS, 'buckets are whole days apart');
  }
  const busy = usage.buckets.filter((b) => b.delivered > 0);
  assert.equal(busy.length, 2, 'two renders, two days');
  // The last bucket is today, which is where the second one landed.
  assert.equal(usage.buckets[29].delivered, 1);
});

test('a request older than the window is not counted at all', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u2' });

  render(billing, clock, { idem: 'old' });
  clock.advance(40 * DAY_MS);
  render(billing, clock, { idem: 'new' });

  assert.equal(billing.usageSummary(USER, { days: 30 }).totals.delivered, 1);
  assert.equal(billing.usageSummary(USER, { days: 90 }).totals.delivered, 2);
});

test('refunds are their own count, not a missing delivery', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u3' });

  render(billing, clock, { idem: 'ok1' });
  render(billing, clock, { idem: 'bad', outcome: 'refunded' });
  render(billing, clock, { idem: 'live', outcome: 'charged' });

  const usage = billing.usageSummary(USER, { days: 30 });
  assert.equal(usage.totals.delivered, 1);
  assert.equal(usage.totals.refunded, 1);
  assert.equal(usage.totals.inFlight, 1, 'a claim that has not settled is neither');
  // Only delivered renders were paid for, which is what the balance already says.
  assert.equal(usage.totals.creditsSpent, 1);
});

test('usage is per key, and a second key does not borrow the first one’s numbers', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u4' });

  render(billing, clock, { idem: 'p1' });
  render(billing, clock, { idem: 'p2' });
  render(billing, clock, { keyId: 'ak_2', idem: 's1' });
  render(billing, clock, { keyId: 'ak_2', idem: 's2', outcome: 'refunded' });

  const byKey = new Map(billing.usageSummary(USER).keys.map((k) => [k.keyId, k]));
  assert.equal(byKey.get(KEY).delivered, 2);
  assert.equal(byKey.get(KEY).refunded, 0);
  assert.equal(byKey.get('ak_2').delivered, 1);
  assert.equal(byKey.get('ak_2').refunded, 1);
  assert.equal(byKey.get('ak_2').creditsSpent, 1, 'a refunded render is not spend');
});

test('another account’s traffic is invisible', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 50, sessionId: 'cs_u5a' });
  billing.creditPurchase({ userId: 'user_2', credits: 50, sessionId: 'cs_u5b' });

  render(billing, clock, { idem: 'mine' });
  const theirs = billing.claimAndDebit({
    keyId: 'ak_theirs', userId: 'user_2', idempotencyKey: 'x', fingerprint: 'fp', cost: 1,
  });
  billing.markSucceeded(theirs.requestId);

  const usage = billing.usageSummary(USER);
  assert.equal(usage.totals.delivered, 1);
  assert.deepEqual(usage.keys.map((k) => k.keyId), [KEY]);
});

test('the 7-day figure is a shorter window than the 30-day one, not a copy of it', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u6' });

  render(billing, clock, { idem: 'ancient' });
  clock.advance(20 * DAY_MS);
  render(billing, clock, { idem: 'recent' });

  const usage = billing.usageSummary(USER, { days: 30 });
  assert.equal(usage.totals.delivered, 2);
  assert.equal(usage.totals.delivered7d, 1);
});

test('the median comes from real durations, and only from delivered renders', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u7' });

  render(billing, clock, { idem: 'fast', tookMs: 10_000 });
  render(billing, clock, { idem: 'mid', tookMs: 14_000 });
  render(billing, clock, { idem: 'slow', tookMs: 30_000 });
  // A failure that took two minutes must not drag the median of DELIVERED renders.
  render(billing, clock, { idem: 'dead', tookMs: 120_000, outcome: 'refunded' });

  const usage = billing.usageSummary(USER);
  assert.equal(usage.totals.medianMs, 14_000);
  assert.equal(usage.durationSample, 3, 'the sample size is reported, not hidden');
});

test('an even sample takes a duration that happened, not the average of two', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u8' });

  render(billing, clock, { idem: 'a', tookMs: 10_000 });
  render(billing, clock, { idem: 'b', tookMs: 20_000 });

  assert.equal(billing.usageSummary(USER).totals.medianMs, 10_000);
});

test('no traffic reports zeros and a null median rather than throwing', () => {
  const billing = createApiBilling(tempDir(), { now: fakeClock(NOON).now });
  const usage = billing.usageSummary('user_nobody');
  assert.deepEqual(usage.keys, []);
  assert.equal(usage.totals.delivered, 0);
  assert.equal(usage.totals.medianMs, null, 'a median of nothing is not zero milliseconds');
  assert.equal(usage.durationSample, 0);
  assert.equal(usage.buckets.length, 30);
});

test('the window is clamped, so a caller cannot ask for a table scan', () => {
  const billing = createApiBilling(tempDir(), { now: fakeClock(NOON).now });
  assert.equal(billing.usageSummary(USER, { days: 3650 }).days, 90);
  assert.equal(billing.usageSummary(USER, { days: 0 }).days, 30, 'a falsy value is the default, not zero days');
  assert.equal(billing.usageSummary(USER, { days: -5 }).days, 1);
  assert.equal(billing.usageSummary(USER, { days: 'abc' }).days, 30);
});

test('the duration sample is capped, and the newest renders are what survive it', () => {
  const clock = fakeClock(NOON);
  const billing = createApiBilling(tempDir(), { now: clock.now });
  billing.creditPurchase({ userId: USER, credits: 100, sessionId: 'cs_u9' });
  for (let i = 0; i < 5; i++) render(billing, clock, { idem: 'r' + i, tookMs: 1000 * (i + 1) });

  const usage = billing.usageSummary(USER, { sample: 3 });
  assert.equal(usage.durationSample, 3);
  // Newest first, so the cap keeps the most recent renders — the ones a "how fast is it
  // right now" question is actually about. Those took 3s, 4s and 5s.
  assert.equal(usage.totals.medianMs, 4000);
});
