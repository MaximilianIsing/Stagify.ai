// Tier: unit (real SQLite, temp data dir) — lib/data/stripe-events.js.
//
// WHAT THIS COVERS
// The webhook idempotency ledger. Stripe delivers at-least-once, so the whole
// point of this store is that the SECOND delivery of an event id is refused —
// but only once the first one actually finished. The cases that matter:
//   - a first claim is fresh; a redelivery after markDone is a duplicate,
//   - a redelivery while the first is still in flight is refused too,
//   - a released claim (the handler threw → Stripe will retry) is claimable
//     again, which is what keeps a failed event from being black-holed,
//   - an abandoned 'processing' row (process killed mid-handler, so release()
//     never ran) becomes claimable after the reclaim window,
//   - an event with no id is never blocked (the ledger is a safety net, not a
//     gate), and
//   - rows outlive Stripe's ~3-day retry window but are pruned eventually, and
//     the ledger survives a reopen (it is on disk, not in memory).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../lib/data/db.js';
import {
  createStripeEventLog,
  STRIPE_EVENT_RECLAIM_MS,
  STRIPE_EVENT_RETENTION_MS,
} from '../../lib/data/stripe-events.js';

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-stripe-events-'));
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

// A clock the test drives, so the reclaim/retention windows are exercised
// without sleeping through them.
function fakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const evt = (id, type = 'checkout.session.completed') => ({ id, type, data: { object: {} } });

test('the first claim is fresh and a redelivery of a handled event is a duplicate', () => {
  const log = createStripeEventLog(tempDir());
  assert.equal(log.claim(evt('evt_1')).fresh, true, 'first delivery owns the event');
  log.markDone('evt_1');

  const again = log.claim(evt('evt_1'));
  assert.equal(again.fresh, false, 'Stripe redelivering a handled event must not re-run it');
  assert.equal(again.reason, 'duplicate');
});

test('a redelivery while the first attempt is still in flight is refused', () => {
  const log = createStripeEventLog(tempDir());
  log.claim(evt('evt_dup'));
  // No markDone yet — the first handler is still running.
  const concurrent = log.claim(evt('evt_dup'));
  assert.equal(concurrent.fresh, false);
  assert.equal(concurrent.reason, 'in_flight');
});

test('distinct event ids never collide', () => {
  const log = createStripeEventLog(tempDir());
  for (const id of ['evt_a', 'evt_b', 'evt_c']) {
    assert.equal(log.claim(evt(id)).fresh, true, `${id} is its own event`);
    log.markDone(id);
  }
  assert.equal(log.count(), 3);
});

test('a released claim is claimable again, so a failed event is retried not swallowed', () => {
  // This is the failure mode a naive "INSERT id, always skip if present" dedup
  // introduces: the handler throws, the route answers 500, Stripe retries — and
  // the retry gets deduped against the attempt that never did anything.
  const log = createStripeEventLog(tempDir());
  assert.equal(log.claim(evt('evt_boom')).fresh, true);
  log.release('evt_boom'); // handler threw
  assert.equal(log.get('evt_boom'), null, 'the claim is gone, not left as processing');

  const retry = log.claim(evt('evt_boom'));
  assert.equal(retry.fresh, true, "Stripe's retry must actually run");
});

test('an abandoned in-flight claim becomes claimable after the reclaim window', () => {
  // The process was killed between claim() and markDone/release, so nothing ever
  // resolved the row. Without the staleness rule that event is blocked forever.
  const clock = fakeClock();
  const log = createStripeEventLog(tempDir(), { now: clock.now });
  assert.equal(log.claim(evt('evt_crash')).fresh, true);

  clock.advance(STRIPE_EVENT_RECLAIM_MS - 1000);
  assert.equal(log.claim(evt('evt_crash')).fresh, false, 'still inside the window: treated as in flight');

  clock.advance(2000); // now past the window
  const reclaimed = log.claim(evt('evt_crash'));
  assert.equal(reclaimed.fresh, true);
  assert.equal(reclaimed.reason, 'reclaimed');
});

test('a completed event stays deduped no matter how much time passes', () => {
  // The reclaim window must apply to 'processing' rows only — a handled event
  // does not become re-runnable just because it got old.
  const clock = fakeClock();
  const log = createStripeEventLog(tempDir(), { now: clock.now });
  log.claim(evt('evt_old'));
  log.markDone('evt_old');

  clock.advance(STRIPE_EVENT_RECLAIM_MS * 10);
  assert.equal(log.claim(evt('evt_old')).fresh, false, 'still a duplicate long after handling');
});

test('an event with no id is never blocked', () => {
  const log = createStripeEventLog(tempDir());
  assert.equal(log.claim({ type: 'x' }).fresh, true);
  assert.equal(log.claim({ type: 'x' }).fresh, true, 'a second one is not deduped against the first');
  assert.equal(log.count(), 0, 'nothing untracked is written');
});

test('rows survive the retry window and are pruned only well beyond it', () => {
  const clock = fakeClock();
  const log = createStripeEventLog(tempDir(), { now: clock.now });
  log.claim(evt('evt_keep'));
  log.markDone('evt_keep');

  // Stripe retries for ~3 days; the row must still be there to dedupe them.
  clock.advance(3 * 24 * 60 * 60 * 1000);
  log.claim(evt('evt_trigger_prune')); // prune runs on each fresh claim
  assert.equal(log.claim(evt('evt_keep')).fresh, false, 'still deduped inside the retry window');

  clock.advance(STRIPE_EVENT_RETENTION_MS);
  log.claim(evt('evt_trigger_prune_2'));
  assert.equal(log.get('evt_keep'), null, 'aged out once no retry could reference it');
});

test('the ledger is on disk: a duplicate is still refused after a restart', () => {
  const base = tempDir();
  const log = createStripeEventLog(base);
  log.claim(evt('evt_persist'));
  log.markDone('evt_persist');

  closeDb(base); // simulate a process restart / redeploy
  const reopened = createStripeEventLog(base);
  assert.equal(reopened.claim(evt('evt_persist')).fresh, false, 'dedup survives a redeploy');
});
