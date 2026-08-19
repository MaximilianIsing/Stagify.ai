// Tier: unit (fake elements, no jsdom) — the master column of the API dashboard:
// api-keys/{inspector,format}.js.
//
// WHAT THIS COVERS
// The list is the page's navigation, so the things that must not break are the ones a
// user would never report as a bug, only as "it feels wrong":
//   - a key name is user-supplied free text going into innerHTML, so escaping first;
//   - the selection round-trips through the URL, and a #key/… for a key that no longer
//     exists resolves to nothing rather than painting an empty pane;
//   - searching filters KEYS ONLY — a search that can hide the way back to the balance
//     is a search people stop using;
//   - `live` / `idle` / `revoked` is one rule, used by both the list and the pane, and
//     `idle` is not a fault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderList, selectionFromHash, hashFor, defaultSelection, ACCOUNT_ITEMS,
} from '../../../public/scripts/api-keys/inspector.js';
import {
  formatAgo, formatCount, formatDuration, formatWhen, keyStatus, noDate, noValue, percent,
} from '../../../public/scripts/api-keys/format.js';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const KEYS = [
  { id: 'ak_live', name: 'Production server', prefix: 'stg_live_9f3a2c', createdAt: NOW - 60 * DAY, lastUsedAt: NOW - 5 * 60 * 1000, revokedAt: null },
  { id: 'ak_idle', name: 'Staging / CI', prefix: 'stg_live_71bd04', createdAt: NOW - 30 * DAY, lastUsedAt: NOW - 6 * DAY, revokedAt: null },
  { id: 'ak_dead', name: 'Zapier integration', prefix: 'stg_live_44c1ef', createdAt: NOW - 90 * DAY, lastUsedAt: NOW - 27 * DAY, revokedAt: NOW - 27 * DAY },
];

const USAGE = {
  days: 30,
  totals: { delivered: 3523, refunded: 27, delivered7d: 826, creditsSpent: 3523, medianMs: 14200 },
  keys: [
    { keyId: 'ak_live', delivered: 3102, refunded: 19, inFlight: 0, creditsSpent: 3102, delivered7d: 791, medianMs: 14200 },
    { keyId: 'ak_idle', delivered: 421, refunded: 8, inFlight: 0, creditsSpent: 421, delivered7d: 35, medianMs: 15800 },
  ],
};

/** The one property renderList needs. */
function host() {
  return { innerHTML: '' };
}

// ── format.js ────────────────────────────────────────────────────────────────

test('key status is one rule: revoked beats everything, then recency', () => {
  assert.equal(keyStatus(KEYS[0], NOW), 'live');
  assert.equal(keyStatus(KEYS[1], NOW), 'idle');
  assert.equal(keyStatus(KEYS[2], NOW), 'revoked');
  // A revoked key that was used a minute before it was revoked is still revoked.
  assert.equal(keyStatus({ revokedAt: NOW, lastUsedAt: NOW }, NOW), 'revoked');
  // Never used is idle, not live — the absence of a timestamp must not read as "now".
  assert.equal(keyStatus({ lastUsedAt: null }, NOW), 'idle');
});

test('the live window is a day, and its edge is closed on the wrong side of it', () => {
  assert.equal(keyStatus({ lastUsedAt: NOW - DAY + 1000 }, NOW), 'live');
  assert.equal(keyStatus({ lastUsedAt: NOW - DAY }, NOW), 'idle');
});

test('elapsed time stops at days rather than rolling into months', () => {
  assert.equal(formatAgo(null, NOW), 'never');
  assert.equal(formatAgo(NOW - 30 * 1000, NOW), 'just now');
  assert.equal(formatAgo(NOW - 60 * 1000, NOW), '1 minute ago');
  assert.equal(formatAgo(NOW - 5 * 60 * 1000, NOW), '5 minutes ago');
  assert.equal(formatAgo(NOW - 2 * HOUR, NOW), '2 hours ago');
  assert.equal(formatAgo(NOW - 90 * DAY, NOW), '90 days ago');
});

test('a clock that has drifted backwards does not print a negative age', () => {
  // Server time and browser time disagree by seconds routinely, and "in -3 minutes"
  // is the kind of thing that makes a whole page look broken.
  assert.equal(formatAgo(NOW + 5000, NOW), 'just now');
});

test('durations change unit rather than growing digits', () => {
  // A tenth of a second under the minute: a render lands between ~10s and ~30s, and
  // whole seconds hide the difference someone is comparing two keys for.
  assert.equal(formatDuration(14200), '14.2s');
  assert.equal(formatDuration(45000), '45.0s');
  assert.equal(formatDuration(90000), '90s');
  assert.equal(formatDuration(900000), '15m');
  // A word, not a dash: nothing on this page prints —, so a column of missing
  // numbers reads as answers rather than as a rendering failure.
  assert.equal(formatDuration(null), noValue());
  assert.equal(formatDuration(undefined), noValue());
  assert.ok(!noValue().includes('—') && !noDate().includes('—'));
});

test('with no pack loaded the placeholders are the English words', () => {
  // Every spec in this file runs with no window and no LanguageSystem, so these are the
  // fallbacks — and they are also what a visitor sees for the moment before the pack
  // lands. A dash would read as a rendering failure; see api-keys/copy.test.js.
  assert.equal(noDate(), 'Never');
  assert.equal(noValue(), 'n/a');
});

test('a percentage of nothing is null, not zero', () => {
  // 0% delivered reads as an outage. A key with no traffic has no delivery rate at all,
  // and the panes print NO_VALUE for it.
  assert.equal(percent(0, 0), null);
  assert.equal(percent(3102, 3121)?.toFixed(1), '99.4');
});

test('counts and dates degrade instead of throwing into the page', () => {
  assert.equal(formatCount(1284), (1284).toLocaleString(undefined, { maximumFractionDigits: 0 }));
  assert.equal(formatCount(null), '0');
  assert.equal(formatWhen(null), noDate());
  assert.equal(formatWhen(undefined), noDate());
});

// ── selection ────────────────────────────────────────────────────────────────

test('the selection round-trips through the URL', () => {
  for (const id of ['usage', 'billing', 'ak_live']) {
    assert.equal(selectionFromHash(hashFor(id), KEYS), id);
  }
});

test('a key id that no longer exists resolves to nothing, not to an empty pane', () => {
  assert.equal(selectionFromHash('#key/ak_deleted', KEYS), null);
  assert.equal(selectionFromHash('', KEYS), null);
  assert.equal(selectionFromHash('#nonsense', KEYS), null);
});

test('a key id is encoded into the hash and decoded back out', () => {
  const odd = [{ id: 'ak/one two', name: 'Odd', revokedAt: null }];
  const hash = hashFor('ak/one two');
  assert.ok(!hash.includes(' '), `${hash} must not carry a raw space`);
  assert.equal(selectionFromHash(hash, odd), 'ak/one two');
});

test('the default selection is the first live key, and billing when there is none', () => {
  assert.equal(defaultSelection(KEYS), 'ak_live');
  assert.equal(defaultSelection([KEYS[2]]), 'billing');
  assert.equal(defaultSelection([]), 'billing');
});

test('an account item id can never be shadowed by a key id', () => {
  // The `key/` prefix is what keeps the two namespaces apart. A key literally called
  // `billing` still gets its own hash.
  const keys = [{ id: 'billing', name: 'Confusing', revokedAt: null }];
  assert.equal(hashFor('billing'), '#billing');
  assert.equal(selectionFromHash('#key/billing', keys), 'billing');
  assert.equal(selectionFromHash('#billing', keys), 'billing');
});

// ── the list ─────────────────────────────────────────────────────────────────

test('a key name is escaped — it is user-supplied text going into innerHTML', () => {
  const h = host();
  renderList(h, { keys: [{ id: 'ak_x', name: '<img src=x onerror=alert(1)>', revokedAt: null }], now: NOW });
  assert.ok(!h.innerHTML.includes('<img'), h.innerHTML);
  assert.ok(h.innerHTML.includes('&lt;img'));
});

test('the list carries every account row and every key, revoked ones included', () => {
  const h = host();
  renderList(h, { keys: KEYS, credits: { balance: 1284 }, usage: USAGE, selected: 'ak_live', now: NOW });

  for (const item of ACCOUNT_ITEMS) {
    assert.match(h.innerHTML, new RegExp(`data-ak-select="${item.id}"`));
  }
  for (const key of KEYS) {
    assert.match(h.innerHTML, new RegExp(`data-ak-select="${key.id}"`));
  }
  // A revoked key stays listed — it is the one you want to recognise in a log.
  assert.match(h.innerHTML, /Zapier integration/);
  assert.match(h.innerHTML, /ak-item--muted/);
});

test('exactly one row is marked current', () => {
  const h = host();
  renderList(h, { keys: KEYS, selected: 'ak_idle', now: NOW });
  assert.equal((h.innerHTML.match(/aria-current="page"/g) || []).length, 1);
  assert.match(h.innerHTML, /data-ak-select="ak_idle" aria-current="page"/);
});

test('the group header counts LIVE keys, not rows', () => {
  const h = host();
  renderList(h, { keys: KEYS, now: NOW });
  assert.match(h.innerHTML, /Keys · 2 live/);
});

test('search filters keys and leaves the account rows alone', () => {
  const h = host();
  renderList(h, { keys: KEYS, filter: 'zapier', now: NOW });

  assert.match(h.innerHTML, /Zapier integration/);
  assert.ok(!h.innerHTML.includes('Production server'), 'a non-matching key must go');
  // The way back to the balance survives every search.
  assert.match(h.innerHTML, /data-ak-select="billing"/);
});

test('a search that matches nothing says so, quoting what was typed — escaped', () => {
  const h = host();
  renderList(h, { keys: KEYS, filter: '<script>', now: NOW });
  assert.ok(!h.innerHTML.includes('<script>'), h.innerHTML);
  assert.match(h.innerHTML, /No key matches/);
});

test('search matches the display prefix too, which is what a log line shows', () => {
  const h = host();
  renderList(h, { keys: KEYS, filter: '71bd04', now: NOW });
  assert.match(h.innerHTML, /Staging \/ CI/);
  assert.ok(!h.innerHTML.includes('Production server'));
});

test('an account with no keys invites the first one instead of showing an empty group', () => {
  const h = host();
  renderList(h, { keys: [], credits: { balance: 0 }, now: NOW });
  assert.match(h.innerHTML, /No keys yet/);
});

test('the account rows read the numbers they claim to', () => {
  const h = host();
  renderList(h, { keys: KEYS, credits: { balance: 1 }, usage: USAGE, now: NOW });
  // Singular, because "1 credits" is the tell of a dashboard nobody proof-read.
  assert.match(h.innerHTML, /1 credit</);
  assert.match(h.innerHTML, /826 renders this week/);
});

test('renderList survives a missing host', () => {
  assert.doesNotThrow(() => renderList(null, { keys: KEYS }));
});
