// Tier: frontend island logic (no DOM) — the analyst's tool executors and its
// pseudonym map.
//
// WHAT THIS FILE IS PROTECTING. The console has one rule it has kept since the
// Signals tab shipped: a person's identity does not leave the browser. Findings
// carry emails only in an `accounts` array that the brief endpoint drops, and
// lib/services/admin-brief.js scrubs anything address-shaped as a backstop.
//
// The analyst strains that rule harder than anything before it, because the most
// valuable questions an operator asks ARE about individuals — who is churning, who
// to email. The answer is analyst-identity.js: the model sees `acct_4f1a2b`, the
// operator sees jane@example.com, and the substitution happens on the way to the
// DOM. That only holds if no executor ever puts a real identifier in a payload, and
// "no executor ever" is a claim about code that has not been written yet.
//
// So the central test here is a SWEEP: run every executor over a fixture stuffed
// with addresses and IPs, and assert nothing address-shaped comes back. It covers a
// tool added next year by construction, which is the only way this survives.
//
// The sibling file admin-analyst-tools.test.js pins the tool NAMES against the
// server's schema registry; this one pins what they return.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAnalystTools } from '../../../public/scripts/admin/analyst-tools.js';
import { createIdentityMap, HANDLE_RE } from '../../../public/scripts/admin/analyst-identity.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// ── Fixtures: deliberately full of things that must not escape ──────────────

const EMAILS = ['jane@example.com', 'ops@northside.co', 'bill@acme.example'];

/** One prompt_logs.csv row, positional — these files are read by index. */
function promptRow({ at = NOW, room = 'Living room', style = 'Modern', email = EMAILS[0], status = 'ok', error = '' } = {}) {
  return [
    new Date(at).toISOString(), room, style, 'make it cosy for jane@example.com', 'false', 'unknown', '',
    email, '203.0.113.9', status, '8000', 'gemini-2.5-flash-image', '1', error, '', '1', '1/1',
  ];
}

function rows(n, spec = {}) {
  return Array.from({ length: n }, (_, i) => promptRow({ ...spec, at: NOW - i * 3600e3 }));
}

function user(over = {}) {
  return {
    id: 'u1',
    email: EMAILS[0],
    plan: 'free',
    createdAt: new Date(NOW - 60 * DAY).toISOString(),
    ...over,
  };
}

/** A dashboard with something for every executor to find. */
function fixture() {
  const promptRows = [
    ['timestamp', 'roomType', 'furnitureStyle'], // header, to prove stripHeader is applied
    ...rows(200, { room: 'Living room' }),
    ...rows(40, { room: 'Dorm', status: 'failed', error: 'E_DORM' }),
  ];
  return {
    data: {
      promptRows,
      chatRows: [['timestamp', 'userId'], [new Date(NOW).toISOString(), 'u1', 'hello jane@example.com', '', '', '', '198.51.100.4', 'UA']],
      maskRows: [['timestamp', 'prompt'], [new Date(NOW).toISOString(), 'erase the sofa', 'm', 'g', '1', '1', 'u1', '192.0.2.7', 'UA']],
      rejectionRows: [
        ['timestamp', 'kind'],
        [new Date(NOW).toISOString(), 'daily_limit', 'DAILY_LIMIT_REACHED', '', EMAILS[1], 'u2', '192.0.2.8', 'UA'],
        [new Date(NOW - DAY).toISOString(), 'unstageable', 'NOT_A_ROOM', '', EMAILS[2], 'u3', '192.0.2.9', 'UA'],
      ],
      contactRows: [['timestamp', 'userRole']],
      users: [
        user(),
        user({ id: 'u2', email: EMAILS[1], plan: 'pro', stripeSubscriptionId: 'sub_1' }),
        user({ id: 'u3', email: EMAILS[2], plan: 'pro', proGrantExpiresAt: new Date(NOW + 2 * DAY).toISOString() }),
      ],
      metrics: {
        generatedAt: NOW,
        renders: {
          total: 240, ok: 200, failed: 40, pending: 0, evicted: 0, distinctUsers: 3,
          firstAt: NOW - 90 * DAY, lastAt: NOW, bySource: [],
          last30d: { total: 240, failed: 40, users: 3 },
          last7d: { total: 60, failed: 10, users: 2 },
          perUser: { accounts: 3, p50: 40, p90: 120, max: 200, top: [{ userId: 'u1', renders: 200 }] },
        },
        accounts: { total: 3, withLiveSession: 1, pendingVerification: 0 },
        storage: { blobs: 10, bytes: 1024, refCount: 2, refBytes: 512, topAccounts: [{ userId: 'u1', bytes: 900, blobs: 8 }] },
        shares: { minted: 4, viewed: 1, views: 9, revoked: 0, lastViewedAt: NOW },
        health: { stuckStripeEvents: 0, stripeReclaimMs: 1000, tombstoneBacklog: 0, tombstonesFailing: 0, lastTombstoneError: null },
        logs: [],
      },
    },
  };
}

function build(ctx = fixture()) {
  const identity = createIdentityMap();
  const tools = createAnalystTools({
    ctx,
    identity,
    currentFindings: () => ({
      findings: [{
        id: 'revenue.at-risk-paying',
        severity: 'critical',
        area: 'Revenue',
        title: 'One paying account has never used the product',
        confidence: 'high',
        sample: 2,
        evidence: [{ label: 'At risk', value: '1 of 2 paying' }],
        // The field the brief endpoint drops. It must not survive list_findings either.
        accounts: [{ email: EMAILS[1], id: 'u2', note: 'never used it' }],
      }],
      failed: [],
    }),
    effectivePlan: (u) => (u && u.plan) || 'free',
  });
  return { tools, identity };
}

/** Every executor, with arguments that make each one actually produce rows. */
const CALLS = [
  { name: 'segment_breakdown', arguments: '{"field":"roomType","days":90}' },
  { name: 'segment_breakdown', arguments: '{"field":"errorCode","days":90}' },
  { name: 'time_series', arguments: '{"metric":"renders","days":30}' },
  { name: 'time_series', arguments: '{"metric":"failures","days":365}' },
  { name: 'compare_windows', arguments: '{"metric":"renders","days":7}' },
  { name: 'render_outcomes', arguments: '{"days":90}' },
  { name: 'rejection_breakdown', arguments: '{"days":90}' },
  { name: 'rejection_breakdown', arguments: '{"days":90,"kind":"unstageable"}' },
  { name: 'funnel_and_retention', arguments: '{}' },
  { name: 'account_lookup', arguments: '{"filter":"paying"}' },
  { name: 'account_lookup', arguments: '{"filter":"at_risk"}' },
  { name: 'account_lookup', arguments: '{"filter":"never_activated"}' },
  { name: 'account_lookup', arguments: '{"filter":"comp_granted","days":30}' },
  { name: 'account_lookup', arguments: '{"filter":"recent_signups","days":90}' },
  { name: 'account_lookup', arguments: '{"filter":"top_users"}' },
  { name: 'metrics_snapshot', arguments: '{}' },
  { name: 'list_findings', arguments: '{}' },
];

// ── The sweep ───────────────────────────────────────────────────────────────

const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

test('no executor puts an address, an IP or a customer prompt in its payload', () => {
  const { tools } = build();
  for (const call of CALLS) {
    const json = tools.run(call);
    const label = `${call.name}(${call.arguments})`;
    assert.ok(!EMAIL_RE.test(json), `${label} leaked something address-shaped: ${json.slice(0, 400)}`);
    assert.ok(!IPV4_RE.test(json), `${label} leaked something IP-shaped: ${json.slice(0, 400)}`);
    // The fixture's renders carry a prompt naming a person. No tool aggregates
    // free text, and none should start.
    assert.ok(!/make it cosy/.test(json), `${label} leaked a customer prompt`);
    assert.ok(!/erase the sofa/.test(json), `${label} leaked a mask-edit prompt`);
  }
});

test('list_findings drops the accounts array, exactly as the brief endpoint does', () => {
  const { tools } = build();
  const out = JSON.parse(tools.run({ name: 'list_findings', arguments: '{}' }));
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].accounts, undefined, 'the accounts field must not survive projection');
  assert.equal(out.rows[0].title, 'One paying account has never used the product');
});

test('an account-shaped answer identifies people by handle', () => {
  const { tools } = build();
  const out = JSON.parse(tools.run({ name: 'account_lookup', arguments: '{"filter":"paying"}' }));
  assert.ok(out.rows.length, 'the fixture has paying accounts');
  for (const r of out.rows) {
    assert.match(r.account, /^acct_[0-9a-f]{6}$/, `expected a handle, got ${r.account}`);
  }
});

test('no tool throws, whatever it is handed', () => {
  // The bag is parsed CSV plus a fetched JSON payload, either of which can be
  // absent or malformed. Same contract the findings registry keeps.
  const junk = [
    { data: {} },
    { data: { promptRows: null, users: null, metrics: undefined } },
    { data: { promptRows: [['timestamp']], users: [null, {}, { email: null }], rejectionRows: [[]] } },
  ];
  for (const ctx of junk) {
    const { tools } = build(/** @type {any} */ (ctx));
    for (const call of CALLS) {
      const json = tools.run(call);
      assert.doesNotThrow(() => JSON.parse(json), `${call.name} returned something unparseable on junk input`);
    }
  }
});

// ── Honesty contracts the executors carry ───────────────────────────────────

test('every result carries caveats where the numbers need them', () => {
  const { tools } = build();
  for (const name of ['segment_breakdown', 'render_outcomes', 'funnel_and_retention', 'metrics_snapshot']) {
    const call = CALLS.find((c) => c.name === name);
    const out = JSON.parse(tools.run(call));
    assert.ok(Array.isArray(out.caveats) && out.caveats.length, `${name} must ship its caveats to the model`);
  }
});

test('an unmeasurable rate is null, never zero and never a hundred', () => {
  // The invariant the whole console turns on: absent must not read as zero. Here,
  // renders with no recorded outcome at all.
  const blank = { data: { promptRows: [['timestamp'], ...rows(50).map((r) => { const c = r.slice(); c[9] = ''; return c; })], users: [] } };
  const { tools } = build(/** @type {any} */ (blank));
  const out = JSON.parse(tools.run({ name: 'render_outcomes', arguments: '{"days":90}' }));
  assert.equal(out.totals.successRatePct, null, 'nothing recorded must be null, not 100');
  assert.ok(out.caveats.some((c) => /null rather than 100/.test(c)), 'and the model must be told what null means');
});

test('a segment is compared against the rest of the product, not against itself', () => {
  // The same correction the rules engine got: a segment inside its own baseline
  // shrinks exactly the gap that matters most.
  const { tools } = build();
  const out = JSON.parse(tools.run({ name: 'segment_breakdown', arguments: '{"field":"roomType","days":90}' }));
  const dorm = out.rows.find((r) => r.segment === 'Dorm');
  assert.ok(dorm, 'the failing room should be in the breakdown');
  assert.equal(dorm.failed, 40);
  assert.equal(dorm.restOfProductRatePct, 0, 'no other room failed, so the rest of the product is at zero');
  assert.ok(Array.isArray(dorm.ci95Pct), 'every rate ships its interval');
});

test('an empty previous window yields a null fold change, not an infinite rise', () => {
  const { tools } = build();
  const out = JSON.parse(tools.run({ name: 'compare_windows', arguments: '{"metric":"signups","days":7}' }));
  assert.equal(out.totals.foldChange, null);
  assert.ok(out.caveats.some((c) => /not an infinite increase/.test(c)));
});

// ── The pseudonym map ───────────────────────────────────────────────────────

test('handles are stable per account and unique across accounts', () => {
  const identity = createIdentityMap();
  const a = identity.handleFor({ id: 'u1', email: EMAILS[0] });
  const b = identity.handleFor({ id: 'u2', email: EMAILS[1] });
  assert.equal(identity.handleFor({ id: 'u1', email: EMAILS[0] }), a, 'the same account must keep its handle');
  assert.notEqual(a, b);
  assert.match(a, /^acct_[0-9a-f]{6}$/);
});

test('a handle carries no information about the account it stands for', () => {
  // Not a hash: a hash is a pseudonym with a preimage, and anyone holding a list of
  // candidate addresses could confirm membership by hashing them.
  const one = createIdentityMap().handleFor({ id: 'u1', email: EMAILS[0] });
  const two = createIdentityMap().handleFor({ id: 'u1', email: EMAILS[0] });
  assert.notEqual(one, two, 'the same account in two sessions must not be correlatable');
});

test('segment resolves a handle back to its address, as text runs', () => {
  const identity = createIdentityMap();
  const h = identity.handleFor({ id: 'u1', email: EMAILS[0] });
  const segs = identity.segment(`Email ${h} first — they have never rendered anything.`);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].text, 'Email ');
  assert.equal(segs[1].text, EMAILS[0]);
  assert.ok(segs[1].account, 'the resolved run must be marked so it can be styled');
  assert.match(segs[2].text, /never rendered/);
});

test('a handle that was never minted here stays plain text', () => {
  // The model can invent one. Rendering an invented handle as an account would be
  // a fabricated identity in an operator console.
  const identity = createIdentityMap();
  const segs = identity.segment('I checked acct_abcdef and it looked fine.');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].account, null);
  assert.match(segs[0].text, /acct_abcdef/);
});

test('reset forgets every account', () => {
  const identity = createIdentityMap();
  const h = identity.handleFor({ id: 'u1', email: EMAILS[0] });
  assert.ok(identity.accountFor(h));
  identity.reset();
  assert.equal(identity.accountFor(h), null, 'a sign-out must not leave addresses alive in a closure');
});

test('the handle regex is anchored to the exact shape the map mints', () => {
  const identity = createIdentityMap();
  const h = identity.handleFor({ id: 'u1' });
  HANDLE_RE.lastIndex = 0;
  assert.ok(new RegExp(HANDLE_RE.source).test(h), 'the shared regex must match what the map produces');
});
