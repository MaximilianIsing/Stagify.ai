// Tier: unit (string assertions, no jsdom) — the API dashboard's detail panes:
// api-keys/{key-detail,account-detail,usage-chart}.js.
//
// WHAT THIS COVERS
// These three render the numbers a developer will act on, so the tests are mostly about
// telling the truth rather than about markup:
//   - MISSING usage renders NO_VALUE, never zeros. "0 renders" and "we could not count
//     your renders" are different claims and only one is true while the call is in
//     flight; this is the whole reason the usage endpoint failing is survivable.
//   - a revoked key keeps its history and loses every control, including Rename —
//     renaming a key nobody can use rewrites the label on an audit trail.
//   - the chart's columns are sized against the tallest column, and an all-zero window
//     must not divide by it.
//   - runway is null when nothing is being spent, because a balance divided by a zero
//     burn is infinity and printing that as days is a lie in the reassuring direction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyDetailHtml, renameFormHtml } from '../../../public/scripts/api-keys/key-detail.js';
import { usageDetailHtml, billingDetailHtml, runwayDays } from '../../../public/scripts/api-keys/account-detail.js';
import { chartHtml } from '../../../public/scripts/api-keys/usage-chart.js';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const LIVE_KEY = {
  id: 'ak_live',
  name: 'Production server',
  prefix: 'stg_live_9f3a2c',
  createdAt: Date.UTC(2026, 2, 4),
  lastUsedAt: NOW - 5 * 60 * 1000,
  revokedAt: null,
};

const DEAD_KEY = { ...LIVE_KEY, id: 'ak_dead', name: 'Zapier integration', revokedAt: NOW - 27 * DAY };

const KEY_USAGE = {
  keyId: 'ak_live', delivered: 3102, refunded: 19, inFlight: 2,
  creditsSpent: 3102, delivered7d: 791, medianMs: 14200,
};

const BUCKETS = [
  { day: NOW - 2 * DAY, delivered: 40, refunded: 0 },
  { day: NOW - DAY, delivered: 100, refunded: 10 },
  { day: NOW, delivered: 20, refunded: 0 },
];

// ── key detail ───────────────────────────────────────────────────────────────

test('the pane shows the prefix and never a whole key', () => {
  const html = keyDetailHtml(LIVE_KEY, { usage: KEY_USAGE, now: NOW });
  assert.match(html, /stg_live_9f3a2c…/);
  // There is no read path that could produce one, and no affordance that implies there is.
  assert.ok(!/show key|reveal/i.test(html), 'the pane must not offer to show the key');
});

test('a key name is escaped — it is user-supplied text going into innerHTML', () => {
  const html = keyDetailHtml({ ...LIVE_KEY, name: '<img src=x onerror=alert(1)>' }, { now: NOW });
  assert.ok(!html.includes('<img'), html.slice(0, 400));
  assert.match(html, /&lt;img/);
});

test('a live key offers Rename and a walled-off Revoke', () => {
  const html = keyDetailHtml(LIVE_KEY, { usage: KEY_USAGE, now: NOW });
  assert.match(html, /data-ak-rename="ak_live"/);
  assert.match(html, /data-revoke-key="ak_live"/);
  assert.match(html, /ak-danger/);
});

test('a revoked key keeps its history and loses every control', () => {
  const html = keyDetailHtml(DEAD_KEY, { now: NOW });
  assert.ok(!html.includes('data-revoke-key'), 'nothing left to revoke');
  assert.ok(!html.includes('data-ak-rename'), 'renaming it would relabel an audit trail');
  assert.match(html, /ak-tag--revoked/);
  // It still says when, because that is the fact a log line is being matched against.
  assert.match(html, /Revoked on/);
});

test('missing usage says so in words, rather than printing zeros', () => {
  const html = keyDetailHtml(LIVE_KEY, { now: NOW });
  assert.match(html, /usage unavailable/);
  assert.ok(!/>0</.test(html.replace(/stg_live_9f3a2c/g, '')), 'no fabricated zeros');
});

test('a key with no traffic reads as idle, NOT as a failed usage call', () => {
  // The summary only carries keys that were used in the window, so a quiet key has no
  // row at all. Without the loaded flag this pane is byte-identical to the one above,
  // and an account that simply has not called us is told its numbers are broken.
  const html = keyDetailHtml(LIVE_KEY, { usageLoaded: true, now: NOW });
  assert.ok(!html.includes('usage unavailable'), 'nothing failed here');
  assert.match(html, /nothing rendered yet/);
  assert.match(html, /0 in the last 7 days/);
});

test('a key with real usage shows the delivery rate it computed', () => {
  const html = keyDetailHtml(LIVE_KEY, { usage: KEY_USAGE, now: NOW });
  assert.match(html, /99\.4%/);      // 3102 of 3121
  assert.match(html, /19 refunded/);
  assert.match(html, /14\.2s/);
  assert.match(html, /2 in flight now/);
});

test('a key that has never failed says so instead of "0 refunded"', () => {
  const html = keyDetailHtml(LIVE_KEY, { usage: { ...KEY_USAGE, refunded: 0 }, now: NOW });
  assert.match(html, /no failed renders/);
});

test('the rename form carries the current name, escaped, and the key it edits', () => {
  const html = renameFormHtml({ id: 'ak_live', name: 'Prod "main"' });
  assert.match(html, /data-ak-rename-form="ak_live"/);
  assert.match(html, /value="Prod &quot;main&quot;"/);
});

test('the pane survives a key that is not there', () => {
  assert.equal(keyDetailHtml(null), '');
});

// ── usage pane ───────────────────────────────────────────────────────────────

const ACCOUNT_USAGE = {
  days: 30,
  buckets: BUCKETS,
  durationSample: 2000,
  totals: { delivered: 3523, refunded: 27, inFlight: 0, creditsSpent: 3523, delivered7d: 826, medianMs: 14600 },
  keys: [
    { keyId: 'ak_live', delivered: 3102, refunded: 19, creditsSpent: 3102, delivered7d: 791, medianMs: 14200 },
    { keyId: 'ak_idle', delivered: 421, refunded: 8, creditsSpent: 421, delivered7d: 35, medianMs: 15800 },
  ],
};

test('the usage pane names keys and lets a row select one', () => {
  const html = usageDetailHtml({
    usage: ACCOUNT_USAGE,
    keys: [{ id: 'ak_live', name: 'Production server' }, { id: 'ak_idle', name: 'Staging / CI' }],
  });
  assert.match(html, /data-ak-select="ak_live"/);
  assert.match(html, /Production server/);
  assert.match(html, /Staging \/ CI/);
});

test('usage from a key that has since been deleted is still counted, and labelled', () => {
  // The requests happened and the credits were spent. Dropping the row would make the
  // by-key table disagree with the total above it.
  const html = usageDetailHtml({ usage: ACCOUNT_USAGE, keys: [] });
  assert.match(html, /Deleted key/);
});

test('the sample cap behind the median is stated, not hidden', () => {
  const html = usageDetailHtml({ usage: ACCOUNT_USAGE, keys: [] });
  assert.match(html, /most recent/);
  assert.match(html, /Days are UTC/);
});

test('a usage endpoint that never answered explains itself and reassures', () => {
  const html = usageDetailHtml({ usage: null, keys: [] });
  assert.match(html, /Could not load usage/);
  assert.match(html, /keys and balance are unaffected/);
});

// ── billing pane ─────────────────────────────────────────────────────────────

test('the billing pane hosts the pack grid and the ledger without rendering either', () => {
  const html = billingDetailHtml({ credits: { balance: 1284, lifetimePurchased: 5000, lifetimeSpent: 3716 } });
  assert.match(html, /id="ak-packs"[^>]*data-loading="true"/);
  assert.match(html, /id="ak-ledger"/);
  // The loading copy is what stops a slow pack fetch reading as an empty grid. It is
  // the docs page's key, because the grid itself is shared with it.
  assert.match(html, /data-lang="developers\.packs\.loading"/);
  assert.match(html, /Loading pricing…/);
});

test('a suspended account is told, in the pane that is about money', () => {
  const html = billingDetailHtml({ credits: { balance: 0, suspended: true } });
  assert.match(html, /id="ak-suspended"/);
  assert.match(html, /suspended/);
});

test('runway is null when nothing is being spent', () => {
  assert.equal(runwayDays(1284, { totals: { delivered7d: 0 } }), null);
  assert.equal(runwayDays(1284, null), null);
  assert.equal(runwayDays(0, { totals: { delivered7d: 826 } }), null);
});

test('runway divides the balance by the last week’s pace', () => {
  // 826 in seven days is 118 a day; 1284 credits is ten and a bit of them.
  assert.equal(runwayDays(1284, { totals: { delivered7d: 826 } }), 10);
  // Never rounds down to zero: "0 days left" is what a balance of nothing looks like.
  assert.equal(runwayDays(1, { totals: { delivered7d: 826 } }), 1);
});

test('the billing pane prints a runway only when there is one', () => {
  const idle = billingDetailHtml({ credits: { balance: 1284 }, usage: { totals: { delivered7d: 0 } } });
  assert.match(idle, /no renders in the last week/);
  const busy = billingDetailHtml({ credits: { balance: 1284 }, usage: { totals: { delivered7d: 826 } } });
  assert.match(busy, /10 days/);
});

// ── chart ────────────────────────────────────────────────────────────────────

test('the chart draws one column per bucket, scaled against the tallest', () => {
  const html = chartHtml(BUCKETS);
  assert.equal((html.match(/ak-chart__col/g) || []).length, 3);
  // The tallest day is 100 delivered + 10 refunded; its delivered bar is 91%.
  assert.match(html, /ak-chart__bar--delivered" style="height:91%/);
});

test('a day with one request is still a visible mark, not a hairline', () => {
  const html = chartHtml([{ day: NOW, delivered: 1000, refunded: 0 }, { day: NOW, delivered: 1, refunded: 0 }]);
  assert.match(html, /height:3%/);
});

test('an all-zero window renders columns rather than dividing by zero', () => {
  const html = chartHtml([{ day: NOW, delivered: 0, refunded: 0 }]);
  assert.ok(!html.includes('NaN'), html);
  assert.match(html, /ak-chart__col/);
});

test('no buckets at all says "no requests yet" instead of drawing an empty box', () => {
  assert.match(chartHtml([]), /No requests yet/);
  assert.match(chartHtml(null), /No requests yet/);
});

test('the refunded segment is only drawn when something was refunded', () => {
  const clean = chartHtml([{ day: NOW, delivered: 10, refunded: 0 }]);
  assert.ok(!clean.includes('ak-chart__bar--refunded'));
  assert.match(chartHtml(BUCKETS), /ak-chart__bar--refunded/);
});

test('each column carries a readable title, and it says UTC', () => {
  const html = chartHtml(BUCKETS);
  assert.match(html, /title="[^"]*UTC · 110 requests · 10 refunded"/);
  // Singular, because "1 requests" is the tell of a dashboard nobody proof-read.
  assert.match(chartHtml([{ day: NOW, delivered: 1, refunded: 0 }]), /1 request"/);
});
