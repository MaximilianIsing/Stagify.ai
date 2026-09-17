// The marketing-email suppression store (lib/data/email-optout.js).
//
// WHY THIS IS TESTED RATHER THAN LEDGERED AS UNTESTED. privacy.html §3.6 states that
// you may opt out of outreach emails "by using the unsubscribe link in any such
// email". Until this store existed there was no link and no route, so the sentence
// was false. A suppression store that quietly fails to suppress puts the policy back
// where it was, and the person has no way to tell — the confirmation page would say
// "you are unsubscribed" while the next sweep mailed them anyway.
//
// Four properties carry that promise, and each is easy to break with a plausible
// edit:
//   1. The token is STABLE. Reissuing per send would break the unsubscribe link in
//      every email already sitting in someone's inbox.
//   2. Address matching is case- and whitespace-insensitive, because the address on
//      the envelope and the address typed at signup are frequently not byte-equal.
//   3. Opting out is IDEMPOTENT. Mail clients prefetch links and Gmail's one-click
//      POSTs, so the second call is normal traffic, not an error.
//   4. Unknown tokens fail closed and change nothing.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDb, closeDb } from '../../lib/data/db.js';
import { createEmailOptOut } from '../../lib/data/email-optout.js';

const dirs = [];
let store;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-optout-'));
  dirs.push(dir);
  getDb(dir);
  store = createEmailOptOut(dir);
});

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh address is not opted out and gets a token', () => {
  assert.equal(store.isOptedOut('agent@example.com'), false);
  const token = store.tokenFor('agent@example.com');
  assert.ok(typeof token === 'string' && token.length >= 40, 'the token must be a real secret');
});

test('the token is stable across sends', () => {
  // The load-bearing one. Every trial email carries this link; reissuing it would
  // silently break the unsubscribe link in every message already delivered.
  const first = store.tokenFor('agent@example.com');
  const second = store.tokenFor('agent@example.com');
  assert.equal(first, second);
});

test('addresses are matched case- and whitespace-insensitively', () => {
  const token = store.tokenFor('Agent@Example.com');
  assert.equal(store.tokenFor('  agent@example.com '), token);
  store.optOutByToken(token);
  assert.equal(store.isOptedOut('AGENT@EXAMPLE.COM'), true);
});

test('opting out suppresses that address and nobody else', () => {
  const mine = store.tokenFor('agent@example.com');
  store.tokenFor('other@example.com');
  store.optOutByToken(mine);
  assert.equal(store.isOptedOut('agent@example.com'), true);
  assert.equal(store.isOptedOut('other@example.com'), false);
});

test('opting out twice is a success, not an error', () => {
  // Mail clients prefetch links, and Gmail's one-click control POSTs on its own
  // schedule. A second call that reported failure would render as "that did not
  // work" to someone who is, in fact, unsubscribed.
  const token = store.tokenFor('agent@example.com');
  assert.equal(store.optOutByToken(token).ok, true);
  assert.equal(store.optOutByToken(token).ok, true);
  assert.equal(store.isOptedOut('agent@example.com'), true);
});

test('the confirmation page can say which address it was', () => {
  const token = store.tokenFor('Agent@Example.com');
  assert.equal(store.optOutByToken(token).email, 'agent@example.com');
});

test('resubscribing is offered and works, with the same token', () => {
  // An accidental click must not be a one-way door.
  const token = store.tokenFor('agent@example.com');
  store.optOutByToken(token);
  assert.equal(store.optInByToken(token).ok, true);
  assert.equal(store.isOptedOut('agent@example.com'), false);
  assert.equal(store.tokenFor('agent@example.com'), token, 'the link must survive a round trip');
});

test('an unknown or empty token changes nothing', () => {
  const token = store.tokenFor('agent@example.com');
  store.optOutByToken(token);
  assert.equal(store.optOutByToken('not-a-real-token').ok, false);
  assert.equal(store.optOutByToken('').ok, false);
  assert.equal(store.optInByToken('not-a-real-token').ok, false);
  // The real opt-out is untouched by the failed calls.
  assert.equal(store.isOptedOut('agent@example.com'), true);
});

test('a malformed address is refused rather than stored', () => {
  assert.equal(store.tokenFor(''), null);
  assert.equal(store.tokenFor(null), null);
  assert.equal(store.isOptedOut(''), false);
});

test('forget removes the row, which is what erasure relies on', () => {
  // lib/data/user-deletion.js lists this table in USER_EMAIL_TABLES; see the header
  // there for why the suppression row goes with the account rather than outliving it.
  const token = store.tokenFor('agent@example.com');
  store.optOutByToken(token);
  assert.equal(store.forget('AGENT@example.com '), 1);
  assert.equal(store.isOptedOut('agent@example.com'), false);
  assert.equal(store.optOutByToken(token).ok, false, 'the old token must stop resolving');
});
