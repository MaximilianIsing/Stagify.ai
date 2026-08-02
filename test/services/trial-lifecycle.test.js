// Trial-lifecycle orchestrator (lib/services/trial-lifecycle.js) over a REAL temp
// auth-store (so trial-tracking.js is exercised too) and a fake email sender that
// records calls. The clock is injected so the age-based sweep is deterministic.
//
// Covers: welcome-on-checkout (idempotent), the activation-vs-value sweep split,
// trial-ending + win-back webhooks, and that a failed send is retried (flag unset).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createTrialLifecycle } from '../../lib/services/trial-lifecycle.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-20T12:00:00Z');

const tempDirs = [];
const openStores = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-trial-'));
  tempDirs.push(dir);
  const store = createAuthStore(dir);
  openStores.push(store);
  return store;
}
afterEach(() => {
  while (openStores.length) {
    try { openStores.pop().close(); } catch { /* already closed */ }
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function fakeEmails(over = {}) {
  const calls = { welcome: [], activation: [], value: [], ending: [], canceled: [] };
  const ok = async (bucket, a) => { calls[bucket].push(a); return { ok: true }; };
  return {
    calls,
    sendTrialWelcome: (a) => ok('welcome', a),
    sendTrialActivationNudge: (a) => ok('activation', a),
    sendTrialValue: (a) => ok('value', a),
    sendTrialEnding: (a) => ok('ending', a),
    sendSubscriptionCanceled: (a) => ok('canceled', a),
    ...over,
  };
}

function proUser(store, email, { sub = 'sub_1', cus = 'cus_1' } = {}) {
  const start = store.startRegistration(email, 'CorrectHorse9!');
  const done = store.completeRegistration(email, start.code);
  store.activateProFromStripeCheckout({ userId: done.user.id, stripeCustomerId: cus, stripeSubscriptionId: sub });
  return done.user;
}

test('onTrialCheckout starts tracking, sends welcome once (idempotent)', async () => {
  const store = freshStore();
  const user = proUser(store, 'welcome@example.com');
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  await life.onTrialCheckout({ userId: user.id });
  await life.onTrialCheckout({ userId: user.id }); // duplicate webhook

  assert.equal(emails.calls.welcome.length, 1, 'welcome sent exactly once');
  assert.equal(emails.calls.welcome[0].toEmail, 'welcome@example.com');
  const tracked = store.listTrialCandidates().find((u) => u.id === user.id);
  assert.ok(tracked && tracked.trialLifecycle.sent.welcome, 'welcome flag recorded');
});

test('sweep: day-2 user who has not staged gets the activation nudge (once)', async () => {
  const store = freshStore();
  const user = proUser(store, 'inactive@example.com');
  store.beginTrial(user.id, new Date(NOW - 2 * DAY).toISOString());
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  const r1 = await life.runSweep();
  const r2 = await life.runSweep(); // second pass must not resend

  assert.equal(r1.activation, 1);
  assert.equal(r2.activation, 0);
  assert.equal(emails.calls.activation.length, 1);
  assert.equal(emails.calls.value.length, 0, 'inactive user gets no value email');
});

test('sweep: day-4 user who IS staging gets the value email, not activation', async () => {
  const store = freshStore();
  const user = proUser(store, 'active@example.com');
  store.beginTrial(user.id, new Date(NOW - 4 * DAY).toISOString());
  store.recordStagingActivity(user.id); // lastStagedAt = now → "activated"
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  const r = await life.runSweep();

  assert.equal(r.value, 1);
  assert.equal(r.activation, 0);
  assert.equal(emails.calls.value.length, 1);
});

test('sweep: a fresh (day-0) trial gets nothing yet', async () => {
  const store = freshStore();
  const user = proUser(store, 'fresh@example.com');
  store.beginTrial(user.id, new Date(NOW - 2 * 60 * 60 * 1000).toISOString()); // 2 hours ago
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  const r = await life.runSweep();
  assert.deepEqual(r, { activation: 0, value: 0 });
});

test('sweep: a failed send leaves the flag unset so the next pass retries', async () => {
  const store = freshStore();
  const user = proUser(store, 'retry@example.com');
  store.beginTrial(user.id, new Date(NOW - 2 * DAY).toISOString());
  let firstTry = true;
  const emails = fakeEmails({
    sendTrialActivationNudge: async () => {
      if (firstTry) { firstTry = false; return { ok: false }; }
      return { ok: true };
    },
  });
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  await life.runSweep(); // fails → no flag
  const r2 = await life.runSweep(); // retries → succeeds
  assert.equal(r2.activation, 1, 'activation retried after the earlier failure');
});

test('onTrialWillEnd emails the mapped user with a daysLeft from trial_end (once)', async () => {
  const store = freshStore();
  const user = proUser(store, 'ending@example.com', { sub: 'sub_end', cus: 'cus_end' });
  store.beginTrial(user.id, new Date(NOW - 5 * DAY).toISOString());
  store.recordStagingActivity(user.id);
  store.recordStagingActivity(user.id); // lifetimeStaged = 2
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  const subscription = { id: 'sub_end', customer: 'cus_end', trial_end: Math.floor((NOW + 2 * DAY) / 1000) };
  await life.onTrialWillEnd({ subscription });
  await life.onTrialWillEnd({ subscription });

  assert.equal(emails.calls.ending.length, 1);
  assert.equal(emails.calls.ending[0].daysLeft, 2);
  assert.equal(emails.calls.ending[0].roomsStaged, 2, 'recap reflects lifetime staged count');
});

test('onSubscriptionCanceled sends the win-back with access-until (once)', async () => {
  const store = freshStore();
  const user = proUser(store, 'cancel@example.com', { sub: 'sub_c', cus: 'cus_c' });
  store.beginTrial(user.id, new Date(NOW - 3 * DAY).toISOString());
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  const subscription = { id: 'sub_c', customer: 'cus_c', current_period_end: Math.floor((NOW + 10 * DAY) / 1000) };
  await life.onSubscriptionCanceled({ subscription });
  await life.onSubscriptionCanceled({ subscription });

  assert.equal(emails.calls.canceled.length, 1);
  assert.ok(emails.calls.canceled[0].accessUntil instanceof Date);
});

// This test used to end in `assert.ok(true)` under the same title — a does-not-throw
// smoke test wearing a behavioural one. Deleting the "already running" guard (so
// start() stacks a second timer) or gutting stop() into a no-op (so the interval
// leaks) both kept it green. Each of the three claims is now actually checked.
test('start() runs an immediate sweep and is idempotent; stop() clears the timer', async () => {
  const store = freshStore();
  // A day-2 user who has not staged is due the activation nudge, so the immediate
  // sweep is OBSERVABLE — with an empty store it was indistinguishable from no sweep.
  const user = proUser(store, 'startsweep@example.com');
  store.beginTrial(user.id, new Date(NOW - 2 * DAY).toISOString());
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });

  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let started = 0;
  let cleared = 0;
  globalThis.setInterval = (...args) => { started += 1; return realSetInterval(...args); };
  globalThis.clearInterval = (...args) => { cleared += 1; return realClearInterval(...args); };

  try {
    life.start(1_000_000);
    // runSweep is async and start() does not await it; let it settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(emails.calls.activation.length, 1, 'start() must run a sweep immediately, not only on the interval');
    assert.equal(started, 1, 'exactly one timer armed');

    life.start(1_000_000); // the "already running" guard
    await new Promise((r) => setImmediate(r));
    assert.equal(started, 1, 'a second start() must NOT arm a second timer');
    assert.equal(emails.calls.activation.length, 1, 'and must not re-sweep, which would resend');

    life.stop();
    assert.equal(cleared, 1, 'stop() must clear the interval, not just drop the reference');
    life.stop();
    assert.equal(cleared, 1, 'stopping twice must not clear anything a second time');

    // Proof the timer is really gone: start() would refuse if one were still held.
    life.start(1_000_000);
    assert.equal(started, 2, 'after stop(), start() must be able to arm a fresh timer');
    life.stop();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test('sweep ignores users with no trial tracking', async () => {
  const store = freshStore();
  proUser(store, 'untracked@example.com'); // pro, but beginTrial never called
  const emails = fakeEmails();
  const life = createTrialLifecycle({ authStore: store, emails, now: () => NOW });
  const r = await life.runSweep();
  assert.deepEqual(r, { activation: 0, value: 0 });
});
