// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/api-usage.js.
//
// Two things are worth pinning here, and neither is a pixel.
//
//   1. **The lazy contract.** This panel is wired into admin.js exactly as Referrals
//      and Status are: fetch on first tab open, refetch when the range changes,
//      invalidate on Refresh and on sign-out. A panel that refetched on every open
//      would put an aggregate query on the production database behind a click, and a
//      panel that never refetched would show yesterday's numbers after a Refresh.
//   2. **Silence must be honest.** A fresh deployment has no API traffic at all, so
//      the empty window is the state this tab is most likely to be seen in first. It
//      must say "no requests" and show an em dash for the median — never a wall of
//      zeros and a 0ms median, which is a claim of instant renders made by an API
//      nobody has called.
//
// The same hand-rolled fake DOM as the other admin suites (no jsdom), plus
// createElementNS, because the daily chart is SVG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, makeEl } from '../../helpers/admin-dom.js';

const dom = makeDom();

/** SVG nodes, for the chart. The shared harness only makes HTML ones. */
function makeSvgEl(tag, ns) {
  const node = makeEl(tag);
  node.namespaceURI = ns || null;
  node.attrs = /** @type {Record<string, string>} */ ({});
  node.setAttribute = function (k, v) { this.attrs[k] = String(v); };
  return node;
}

globalThis.document = /** @type {any} */ ({
  get body() { return dom.body; },
  createElement: (tag) => dom.createElement(tag),
  createElementNS: (ns, tag) => makeSvgEl(tag, ns),
  createTextNode: (t) => dom.createTextNode(t),
  getElementById: (id) => dom.getElementById(id),
  querySelector: (s) => dom.querySelector(s),
  querySelectorAll: (s) => dom.querySelectorAll(s),
});

const { createApiUsagePanel, fmtMs, refundRate, dayLabel } = await import(
  '../../../public/scripts/admin/api-usage.js'
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 2, 0, 0, 0);

// ---- Formatters ------------------------------------------------------------

test('a duration reads at every scale, and no sample is an em dash', () => {
  assert.equal(fmtMs(420), '420ms');
  assert.equal(fmtMs(8400), '8.4s');
  assert.equal(fmtMs(95_000), '1m 35s');
  // The one that matters: null is "nothing completed", not "completed instantly".
  assert.equal(fmtMs(null), '—');
  assert.equal(fmtMs(undefined), '—');
  assert.equal(fmtMs(0), '0ms', 'a real zero is still a zero');
});

test('a refund rate on no traffic is null, not 0%', () => {
  assert.equal(refundRate(0, 0), null, 'an idle API has not proved anything about reliability');
  assert.equal(refundRate(9, 1), '10.0%');
  assert.equal(refundRate(0, 3), '100.0%');
});

test('day labels are UTC, matching the server buckets', () => {
  // Late-UTC-evening: in any timezone west of UTC a local-time label would render
  // the previous day here, silently shifting every column by one.
  assert.equal(dayLabel(Date.UTC(2026, 7, 18, 23, 30)), 'Aug 18');
});

// ---- Driving the island ----------------------------------------------------

function usage(overrides = {}) {
  const buckets = overrides.buckets || [
    { day: NOW - 2 * DAY, delivered: 3, refunded: 0 },
    { day: NOW - 1 * DAY, delivered: 0, refunded: 0 },
    { day: NOW, delivered: 5, refunded: 1 },
  ];
  return {
    generatedAt: NOW,
    since: NOW - 2 * DAY,
    days: 3,
    buckets,
    traffic: {
      delivered: 8, refunded: 1, inFlight: 2, creditsBurned: 8,
      medianMs: 7400, durationSample: 8,
    },
    accounts: [
      { userId: 'u1', email: 'busy@example.com', plan: 'pro', delivered: 6, refunded: 1, inFlight: 2, creditsSpent: 6, delivered7d: 6, keysUsed: 2, lastRequestAt: NOW },
      { userId: 'u2', email: '', plan: '', delivered: 2, refunded: 0, inFlight: 0, creditsSpent: 2, delivered7d: 2, keysUsed: 1, lastRequestAt: null },
    ],
    accountsTotal: 2,
    accountsShown: 2,
    economics: {
      outstanding: 40, lifetimePurchased: 100, lifetimeSpent: 60,
      fundedAccounts: 2, suspended: 1, purchasedInWindow: 100, grantedInWindow: 25,
    },
    keys: { total: 5, active: 3, accounts: 2 },
    ...overrides,
  };
}

/** Drive the island against a scripted server. */
function mount(payload) {
  /** @type {string[]} */
  const urls = [];
  const panel = createApiUsagePanel({
    apiSend: (url) => {
      urls.push(url);
      return Promise.resolve(typeof payload === 'function' ? payload(url) : payload);
    },
  });
  return { panel, urls };
}

/** Collect the text of every node in a subtree, the fake DOM's children included. */
function textOf(node, out = []) {
  if (!node) return out;
  if (node.textContent) out.push(node.textContent);
  for (const c of node.children || []) textOf(c, out);
  return out;
}

const bodyText = (sel) => textOf(dom.querySelector(sel)).join(' ');

// ---- The lazy contract -----------------------------------------------------

test('it fetches once, and a second tab open is free', async () => {
  const { panel, urls } = mount({ usage: usage() });

  panel.ensureLoaded();
  await Promise.resolve();
  await Promise.resolve();
  panel.ensureLoaded();
  panel.ensureLoaded();
  await Promise.resolve();

  assert.equal(urls.length, 1, 'reopening the tab must not re-run the aggregate query');
  assert.match(urls[0], /^\/api\/admin\/api-usage\?days=30$/, 'the default window is 30 days');
});

test('reset makes the next open refetch, and clears what was on screen', async () => {
  const { panel, urls } = mount({ usage: usage() });

  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();
  assert.match(bodyText('#adm-api-accounts'), /busy@example.com/);

  panel.reset();
  // Sign-out clears through the same path, so nothing may survive it.
  assert.equal(bodyText('#adm-api-accounts'), '');
  assert.equal(dom.querySelector('#adm-api-account-count').textContent, '0');

  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(urls.length, 2, 'Refresh has to invalidate, or the tab shows stale numbers');
});

// ---- What it renders -------------------------------------------------------

test('the headline numbers reach the cards, refunds included', async () => {
  const { panel } = mount({ usage: usage() });
  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();

  const text = bodyText('#adm-api-stats');
  assert.match(text, /Renders delivered/);
  assert.match(text, /2 still in flight/);
  // The refund count AND the rate it works out to — 1 of 9 requests.
  assert.match(text, /Refunded/);
  assert.match(text, /11\.1% of requests/);
  assert.match(text, /7\.4s/, 'the median render time');
  assert.match(text, /from 8 renders/, 'and the sample it came from');
  assert.match(text, /Live keys/);
});

test('the accounts table names every caller and flags a deleted one', async () => {
  const { panel } = mount({ usage: usage() });
  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();

  const text = bodyText('#adm-api-accounts');
  assert.match(text, /busy@example\.com/);
  // A request whose account is gone still happened; it must not vanish from the
  // table just because the join found no email.
  assert.match(text, /\(deleted account\)/);
  assert.equal(dom.querySelector('#adm-api-account-count').textContent, '2');
});

test('credits sold and credits granted are reported apart', async () => {
  const { panel } = mount({ usage: usage() });
  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();

  const text = bodyText('#adm-api-economics');
  assert.match(text, /Sold in this window/);
  assert.match(text, /Granted in this window/);
  // Both add balance and both let someone render; only one was paid for. A single
  // merged "credits added" line would be the failure this asserts against.
  assert.match(text, /not paid for/);
  assert.match(text, /Outstanding balance/);
  assert.match(text, /Suspended accounts/);
});

// ---- Silence must be honest ------------------------------------------------

test('an empty window says so instead of drawing a row of zeros', async () => {
  const { panel } = mount({
    usage: usage({
      buckets: [
        { day: NOW - 1 * DAY, delivered: 0, refunded: 0 },
        { day: NOW, delivered: 0, refunded: 0 },
      ],
      traffic: { delivered: 0, refunded: 0, inFlight: 0, creditsBurned: 0, medianMs: null, durationSample: 0 },
      accounts: [],
      accountsTotal: 0,
      accountsShown: 0,
    }),
  });
  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();

  assert.match(bodyText('#adm-api-charts'), /No API requests in this window/);
  assert.match(bodyText('#adm-api-accounts'), /No account has called the API/);

  const stats = bodyText('#adm-api-stats');
  assert.match(stats, /—/, 'a median with no sample is an em dash');
  assert.match(stats, /No requests in this window/, 'and the refund rate is absent, not 0%');
  assert.ok(!/0\.0% of requests/.test(stats), '0% refunds on zero traffic is a claim nothing supports');
});

test('a null payload is the documented degrade, not a crash', async () => {
  // GET /api/admin/api-usage answers 200 with { usage: null } on a deployment with
  // no aggregator. The panel has to explain that rather than rendering blank cards.
  const { panel } = mount({ usage: null, reason: 'unavailable' });
  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();

  assert.match(bodyText('#adm-api-stats'), /unavailable on this deployment/);
});

test('a failed fetch reports the error in place', async () => {
  const panel = createApiUsagePanel({
    apiSend: () => Promise.reject(new Error('HTTP 403')),
  });
  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  assert.match(bodyText('#adm-api-stats'), /Could not load API usage: HTTP 403/);
});

test('a capped account list says how many it is hiding', async () => {
  const { panel } = mount({
    usage: usage({ accountsTotal: 137, accountsShown: 2 }),
  });
  panel.ensureLoaded();
  await Promise.resolve(); await Promise.resolve();

  assert.match(bodyText('#adm-api-accounts'), /top 2 of 137 accounts/,
    'presenting the top slice as the whole population is the failure here');
});
