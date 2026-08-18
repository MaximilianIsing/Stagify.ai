// Tier: frontend island logic (no DOM) — public/scripts/admin/findings*.js.
//
// WHY THIS EXISTS. The Insights tab draws charts and lets a person judge them.
// This engine does the judging, which means a wrong rule does not look wrong: it
// looks like a confident sentence with a number in it. Three failure modes are
// worth more than all the rest, and most of this file is aimed at them.
//
//   1. **Firing on noise.** A rule that calls a critical on eight renders trains
//      the operator to ignore the tab, after which the tab is worse than nothing.
//      The table-driven sweeps below hold EVERY rule to the same contract — say
//      nothing on an empty dataset, say nothing on a tiny one — so a rule added
//      later is covered by construction rather than by whoever remembers.
//   2. **Silence reading as health.** An empty Signals tab must never mean "all
//      clear" when it actually means "not measured yet". That is what
//      `suppressed()` and the roll-up finding are for, and it is asserted
//      directly.
//   3. **Leaking a person into the brief.** Findings may carry account emails for
//      the card to render, but ONLY in the `accounts` array, which
//      lib/services/admin-brief.js drops before the model sees anything. An email
//      interpolated into a title would slip past that. The last test sweeps every
//      rendered string across a fixture full of addresses.
//
// Fixtures are built relative to `now`, which is INJECTED throughout, so nothing
// here rots into a suite that passes until some future date.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_RULES, runFindings, sortFindings, finding, confidenceFor, SEVERITY_RANK,
} from '../../../public/scripts/admin/findings.js';
import { activityIndexFrom } from '../../../public/scripts/admin/analytics-users.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00Z');

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * One prompt_logs.csv row, all 16 columns.
 * Positional on purpose: these files are read by index, so a fixture built from
 * named fields would not catch a column map that had drifted.
 */
function promptRow({
  at = NOW, room = 'Living room', style = 'Modern', email = 'a@example.com',
  status = 'ok', durationMs = 8000, model = 'gemini-2.5-flash-image', attempts = 1,
  error = '', drift = '', seed = '1',
} = {}) {
  return [
    new Date(at).toISOString(), room, style, '', 'false', 'unknown', '',
    email, '10.0.0.1', status, String(durationMs), model, String(attempts), error, drift, seed,
  ];
}

/** `n` rows spread one per hour back from `at`, so they land in distinct buckets. */
function rows(n, spec = {}, at = NOW) {
  return Array.from({ length: n }, (_, i) => promptRow({ ...spec, at: at - i * 60 * 60 * 1000 }));
}

function user(over = {}) {
  return {
    id: 'u1', email: 'a@example.com', plan: 'free', createdAt: new Date(NOW - 60 * DAY).toISOString(), ...over,
  };
}

/** A healthy, unremarkable dataset — the baseline most cases perturb. */
function baseInput(over = {}) {
  const promptRows = rows(300, {}, NOW);
  return {
    now: NOW,
    promptRows,
    contactRows: [],
    users: [user()],
    enterprise: [],
    metrics: null,
    index: activityIndexFrom({ promptRows }),
    effectivePlan: (u) => (u && u.plan) || 'free',
    ...over,
  };
}

/** Run the engine and return the finding with this id, if any. */
function findingById(input, id) {
  return runFindings(input).findings.find((f) => f.id === id) || null;
}

// ── The contract every rule keeps ───────────────────────────────────────────

test('the registry is non-empty and every rule is well formed', () => {
  // A regex or an import that stopped working would make every sweep below vacuous.
  assert.ok(ALL_RULES.length >= 20, `expected the full registry, found ${ALL_RULES.length}`);
  for (const rule of ALL_RULES) {
    assert.equal(typeof rule.id, 'string', 'a rule needs an id');
    assert.ok(rule.id.includes('.'), `rule id should be namespaced: ${rule.id}`);
    assert.equal(typeof rule.run, 'function', `${rule.id} has no run()`);
  }
  const ids = ALL_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'two rules share an id, so one would overwrite the other');
});

test('no rule invents a finding from an empty dataset', () => {
  // The table-driven half of failure mode 1. Each rule is run in isolation so a
  // failure names the rule rather than the engine.
  const empty = { now: NOW, promptRows: [], contactRows: [], users: [], enterprise: [], metrics: null, index: activityIndexFrom({}) };
  for (const rule of ALL_RULES) {
    const out = rule.run(empty);
    if (out === null || (out && out.suppressed)) continue;
    // The one legitimate exception: the rule whose whole job is to report that
    // the metrics pack is missing.
    assert.equal(out.id, 'quality.metrics-unavailable', `${rule.id} produced a finding from no data at all`);
  }
});

test('no rule fires on a handful of rows', () => {
  // 6 renders, half of them failed — a 50% failure rate that must NOT become a
  // critical. This is the case that would otherwise make the tab cry wolf on day one.
  const promptRows = [
    ...rows(3, { status: 'failed', error: 'E_BOOM' }),
    ...rows(3, { status: 'ok' }),
  ];
  const input = baseInput({ promptRows, index: activityIndexFrom({ promptRows }) });

  const alarming = runFindings(input).findings.filter((f) => f.severity === 'critical' || f.severity === 'warning');
  assert.deepEqual(
    alarming.map((f) => f.id),
    [],
    'a six-render sample must not produce an alarm',
  );
});

test('every emitted finding carries an action and a title', () => {
  // A finding without a next step is an observation, and observations belong on
  // the Insights tab. `finding()` and the runner both filter for this; the sweep
  // proves the filter is not the only thing keeping it true.
  const inputs = [baseInput(), baseInput({ metrics: fullMetrics() }), messyInput()];
  for (const input of inputs) {
    for (const f of runFindings(input).findings) {
      assert.ok(f.title && f.title.trim(), `${f.id} has no title`);
      assert.ok(f.action && f.action.trim(), `${f.id} has no action`);
      assert.ok(f.severity in SEVERITY_RANK, `${f.id} has an unknown severity: ${f.severity}`);
      assert.ok(Array.isArray(f.evidence), `${f.id} has no evidence array`);
    }
  }
});

test('a rule that throws is contained, and named', () => {
  // renderers.js wraps each chart island in its own try/catch for the same reason:
  // one bad aggregation must not blank the whole tab.
  const exploder = { id: 'test.exploder', area: 'Test', run() { throw new Error('boom'); } };
  ALL_RULES.push(exploder);
  try {
    const result = runFindings(baseInput());
    assert.ok(result.failed.includes('test.exploder'), 'the failing rule should be reported');
    assert.ok(result.findings.length > 0, 'the other rules should still have produced findings');
  } finally {
    ALL_RULES.pop();
  }
});

test('junk input does not throw anywhere in the registry', () => {
  // The bag is assembled from parsed CSV and a fetched JSON payload, either of
  // which can be malformed. A throw here is a blank tab.
  const junk = {
    now: NOW,
    promptRows: [[], ['only-one-cell'], null, undefined, ['a', 'b', 'c']],
    contactRows: null,
    users: [null, {}, { email: null }, { plan: 'pro' }],
    enterprise: [null, {}],
    metrics: { renders: null, shares: 'nope', storage: 0, health: [], logs: 'x' },
    index: activityIndexFrom({}),
  };
  const result = runFindings(/** @type {any} */ (junk));
  assert.deepEqual(result.failed, [], `rules threw on malformed input: ${result.failed.join(', ')}`);
});

// ── Silence must be honest ──────────────────────────────────────────────────

test('a thin dataset reports what it could not check, rather than nothing', () => {
  // Failure mode 2. Without the roll-up, a brand-new deployment and a working,
  // problem-free one render identically.
  const result = runFindings({ now: NOW, promptRows: [], users: [], index: activityIndexFrom({}) });
  const rollup = result.findings.find((f) => f.id === 'quality.suppressed-for-sample');

  assert.ok(rollup, 'an empty dataset must say the checks did not run');
  assert.ok(result.suppressed.length >= 3, 'several rules should report a thin sample');
  assert.equal(rollup.severity, 'quality');
  assert.ok(
    rollup.evidence.every((e) => /\d/.test(e.value)),
    'each suppression reason should say how much data is missing, not just that some is',
  );
});

test('the roll-up disappears once the rules can run', () => {
  const result = runFindings(baseInput({ metrics: fullMetrics() }));
  const reasons = result.suppressed.join(' | ');
  assert.ok(
    !reasons.includes('Failure-rate monitoring'),
    `the failure rule should run on 300 renders, but was suppressed: ${reasons}`,
  );
});

// ── Ordering ────────────────────────────────────────────────────────────────

test('findings sort by severity, then sample, then id — deterministically', () => {
  const mk = (id, severity, sample) => finding({ id, severity, area: 'A', title: id, action: 'do', sample });
  const sorted = sortFindings([
    mk('b.two', 'healthy', 10),
    mk('a.one', 'critical', 5),
    mk('c.three', 'warning', 100),
    mk('d.four', 'warning', 100),
  ]);
  assert.deepEqual(sorted.map((f) => f.id), ['a.one', 'c.three', 'd.four', 'b.two']);
});

test('equal findings keep a stable order across repeated sorts', () => {
  // Without the id tiebreak, a list of equal-severity findings could reshuffle
  // between two refreshes of unchanged data, which reads as though something moved.
  const mk = (id) => finding({ id, severity: 'warning', area: 'A', title: id, action: 'do', sample: 50 });
  const once = sortFindings([mk('z'), mk('a'), mk('m')]).map((f) => f.id);
  const twice = sortFindings([mk('m'), mk('z'), mk('a')]).map((f) => f.id);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ['a', 'm', 'z']);
});

test('counts separate the actionable severities from the rest', () => {
  const result = runFindings(baseInput());
  const actionable = result.findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'warning' || f.severity === 'opportunity',
  ).length;
  assert.equal(result.counts.actionable, actionable);
});

test('confidence follows sample size', () => {
  assert.equal(confidenceFor(1000), 'high');
  assert.equal(confidenceFor(60), 'medium');
  assert.equal(confidenceFor(3), 'low');
  assert.equal(confidenceFor(0), 'low');
});

// ── Reliability ─────────────────────────────────────────────────────────────

test('a segment that genuinely fails more often is reported with its interval', () => {
  // 120 kitchen renders at a 40% failure rate against 400 clean ones. Large
  // enough to clear both gates, so this is the case that SHOULD fire.
  const promptRows = [
    ...rows(400, { room: 'Living room', status: 'ok' }),
    ...Array.from({ length: 48 }, (_, i) => promptRow({ room: 'Kitchen', status: 'failed', error: 'E_KITCHEN', at: NOW - i * 3600e3 })),
    ...Array.from({ length: 72 }, (_, i) => promptRow({ room: 'Kitchen', status: 'ok', at: NOW - i * 3600e3 })),
  ];
  const f = findingById(baseInput({ promptRows, index: activityIndexFrom({ promptRows }) }), 'reliability.room-failure');

  assert.ok(f, 'a 40%-vs-0% gap on 120 renders should be reported');
  assert.match(f.title, /Kitchen/);
  assert.ok(['critical', 'warning'].includes(f.severity));
  assert.ok(f.evidence.some((e) => e.label === '95% interval'), 'the interval is the evidence and must be shown');
  assert.ok(f.sample >= 100, `the sample should be the segment size, got ${f.sample}`);
});

test('the same gap on a tiny segment is NOT reported', () => {
  // 3 of 8 — the case pinned in admin-stats.test.js as one that clears the Wilson
  // test but must still be suppressed by the minimum sample. This is the
  // assertion that would fail if someone deleted the n floor as redundant.
  const promptRows = [
    ...rows(400, { room: 'Living room', status: 'ok' }),
    ...Array.from({ length: 3 }, (_, i) => promptRow({ room: 'Attic', status: 'failed', at: NOW - i * 3600e3 })),
    ...Array.from({ length: 5 }, (_, i) => promptRow({ room: 'Attic', status: 'ok', at: NOW - i * 3600e3 })),
  ];
  const f = findingById(baseInput({ promptRows, index: activityIndexFrom({ promptRows }) }), 'reliability.room-failure');
  assert.equal(f, null, 'an eight-render segment must not produce a finding');
});

test('free-text room spellings are folded, not charted as separate rooms', () => {
  // "Living room" and "Living Room" are the same room written by two client
  // versions. Grouping on the raw string would split the sample in half and could
  // push both halves under the minimum.
  const promptRows = [
    ...rows(200, { room: 'Living room', status: 'ok' }),
    ...Array.from({ length: 60 }, (_, i) => promptRow({ room: 'living  ROOM', status: 'failed', at: NOW - i * 3600e3 })),
  ];
  const f = findingById(baseInput({ promptRows, index: activityIndexFrom({ promptRows }) }), 'reliability.room-failure');
  // Folded together the segment is 260 renders at ~23%, which matches the global
  // rate exactly — so nothing is an outlier and nothing should be reported.
  assert.equal(f, null, 'the two spellings should fold into one segment, leaving no outlier');
});

test('unrecorded outcomes never become a failure rate', () => {
  // The invariant from docs/guides/admin-dashboard.md: a render logged before the
  // outcome columns existed has an empty status. Counting those as failures would
  // paint an error spike across the entire history.
  const promptRows = rows(300, { status: '' });
  const result = runFindings(baseInput({ promptRows, index: activityIndexFrom({ promptRows }) }));

  const alarms = result.findings.filter((f) => f.severity === 'critical' && f.area === 'Reliability');
  assert.deepEqual(alarms.map((f) => f.id), [], 'rows with no verdict must not read as failures');
  assert.ok(
    result.suppressed.some((s) => /recorded outcomes/.test(s)),
    'and the tab should say the failure check could not run',
  );
});

test('architecture drift is read from column 14, and an empty verdict is not "clean"', () => {
  // The column was written and unread for weeks. An empty cell means the question
  // was never asked, NOT that the render preserved the room — so those rows are
  // excluded exactly as unrecorded outcomes are.
  const drifted = [
    ...Array.from({ length: 40 }, (_, i) => promptRow({ drift: 'yes', at: NOW - i * 3600e3 })),
    ...Array.from({ length: 60 }, (_, i) => promptRow({ drift: 'no', at: NOW - i * 3600e3 })),
  ];
  const f = findingById(baseInput({ promptRows: drifted, index: activityIndexFrom({ promptRows: drifted }) }), 'reliability.architecture-drift');
  assert.ok(f, '40% drift across 100 verdicts should be reported');
  assert.equal(f.severity, 'critical');
  assert.match(f.title, /40\.0%/);

  // The same 40 drifted renders among rows that never recorded a verdict must not
  // be diluted into a 4% rate.
  const mostlyBlank = [...drifted.slice(0, 40), ...rows(900, { drift: '' })];
  const g = findingById(baseInput({ promptRows: mostlyBlank, index: activityIndexFrom({ promptRows: mostlyBlank }) }), 'reliability.architecture-drift');
  assert.ok(g, 'the rule should still run on the 40 rows that DID record a verdict');
  assert.match(g.title, /100\.0%/, 'the rate is over recorded verdicts, not over every row');
});

test('a failure code never seen before is surfaced even at a low count', () => {
  const promptRows = [
    ...Array.from({ length: 30 }, (_, i) => promptRow({ status: 'failed', error: 'E_OLD', at: NOW - (30 + i) * DAY })),
    ...Array.from({ length: 4 }, (_, i) => promptRow({ status: 'failed', error: 'E_BRAND_NEW', at: NOW - i * 3600e3 })),
    ...rows(200, { status: 'ok' }),
  ];
  const f = findingById(baseInput({ promptRows, index: activityIndexFrom({ promptRows }) }), 'reliability.new-error-code');
  assert.ok(f, 'a code with no history should be reported');
  assert.match(f.title, /E_BRAND_NEW/);
});

test('with no failure history, nothing is called a NEW error code', () => {
  // Everything is "new" on a fresh log. That is a statement about the log's age,
  // not about the product.
  const promptRows = Array.from({ length: 20 }, (_, i) => promptRow({ status: 'failed', error: 'E_FIRST', at: NOW - i * 3600e3 }));
  const f = findingById(baseInput({ promptRows, index: activityIndexFrom({ promptRows }) }), 'reliability.new-error-code');
  assert.equal(f, null);
});

// ── Revenue ─────────────────────────────────────────────────────────────────

test('a paying account that has never used the product is a critical', () => {
  const users = [
    user({ id: 'p1', email: 'pays@example.com', plan: 'pro', stripeSubscriptionId: 'sub_1' }),
    user({ id: 'p2', email: 'active@example.com', plan: 'pro', stripeSubscriptionId: 'sub_2', lastStagedAt: new Date(NOW - DAY).toISOString() }),
  ];
  const f = findingById(baseInput({ users }), 'revenue.at-risk-paying');

  assert.ok(f);
  assert.equal(f.severity, 'critical');
  assert.equal(f.sample, 2, 'the sample is the paying population');
  assert.ok(f.accounts.some((a) => a.email === 'pays@example.com'), 'the account should be listed for the card');
  assert.ok(f.accounts.every((a) => a.email !== 'active@example.com'), 'a recently active payer is not at risk');
});

test('a comp grant is not counted as revenue', () => {
  // A grant sets plan='pro' but never writes a subscription id, and pro-grants.js
  // refuses to overwrite one. Treating a comp as a payer would put a free account
  // on the churn list and inflate the conversion rate.
  const users = [user({ id: 'g1', email: 'comped@example.com', plan: 'pro', proGrantExpiresAt: new Date(NOW + 40 * DAY).toISOString() })];
  assert.equal(findingById(baseInput({ users }), 'revenue.at-risk-paying'), null);

  const mix = findingById(baseInput({ users: [...users, ...Array.from({ length: 20 }, (_, i) => user({ id: `f${i}`, email: `f${i}@example.com` }))] }), 'revenue.paid-mix');
  assert.ok(mix);
  assert.ok(mix.evidence.some((e) => /Comped/.test(e.label) && e.value === '1'));
  assert.ok(mix.evidence.some((e) => /Paying/.test(e.label) && e.value === '0'));
});

test('a comp grant about to lapse is reported, because nothing else announces it', () => {
  const users = [user({ id: 'g1', email: 'comped@example.com', plan: 'pro', proGrantExpiresAt: new Date(NOW + 3 * DAY).toISOString() })];
  const f = findingById(baseInput({ users }), 'revenue.comp-grants');
  assert.ok(f);
  assert.equal(f.accounts[0].note, '3d left');
});

test('a revoked grant and one on a paying account are both left alone', () => {
  const users = [
    user({ id: 'g1', email: 'revoked@example.com', proGrantExpiresAt: new Date(NOW + 3 * DAY).toISOString(), proGrantRevokedAt: new Date(NOW).toISOString() }),
    user({ id: 'g2', email: 'upgraded@example.com', proGrantExpiresAt: new Date(NOW + 3 * DAY).toISOString(), stripeSubscriptionId: 'sub_9' }),
  ];
  assert.equal(findingById(baseInput({ users }), 'revenue.comp-grants'), null);
});

test('welcome emails sent with zero trial-ending reminders is a critical', () => {
  // The only lifecycle email with no sweep behind it; it fires solely from a
  // Stripe webhook that has to be enabled by hand. A zero here means the
  // highest-intent message in the funnel has never once been sent.
  const users = [user({
    plan: 'pro',
    stripeSubscriptionId: 'sub_1',
    lastStagedAt: new Date(NOW - DAY).toISOString(),
    trialLifecycle: { startAt: new Date(NOW - 20 * DAY).toISOString(), sent: { welcome: new Date(NOW - 20 * DAY).toISOString(), ending: null } },
  })];
  const f = findingById(baseInput({ users }), 'revenue.trial-ending-unsent');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
  assert.match(f.action, /trial_will_end/, 'the action must name the exact Stripe setting');
});

test('once an ending reminder has gone out, the rule goes quiet', () => {
  const users = [user({
    plan: 'pro',
    trialLifecycle: { startAt: new Date(NOW - 20 * DAY).toISOString(), sent: { welcome: 'x', ending: 'y' } },
  })];
  assert.equal(findingById(baseInput({ users }), 'revenue.trial-ending-unsent'), null);
});

// ── Measurement quality ─────────────────────────────────────────────────────

test('columns that nothing writes are named, along with the charts built on them', () => {
  const f = findingById(baseInput(), 'quality.inert-columns');
  assert.ok(f, 'the fixture writes userRole="unknown" and no contact rows, so this must fire');
  assert.equal(f.severity, 'quality');
  assert.ok(f.evidence.some((e) => /userRole/.test(e.label)));
  assert.ok(f.evidence.some((e) => /contact_logs/.test(e.label)));
  assert.match(f.detail, /User roles|Referral sources/, 'the affected cards should be named');
});

test('the rule retires itself once a capture starts filling the columns', () => {
  // Checked against the data rather than hard-coded, so a card asserting "these
  // are dead" cannot outlive the fact.
  const promptRows = rows(300, {}).map((r) => { const c = [...r]; c[5] = 'Agent'; c[6] = 'Google'; return c; });
  const contactRows = [['2026-06-01T00:00:00Z', 'Agent', 'Google', 'x@example.com', 'ua', 'ip']];
  assert.equal(findingById(baseInput({ promptRows, contactRows, index: activityIndexFrom({ promptRows }) }), 'quality.inert-columns'), null);
});

test('the attribution gap is a caveat without the metrics pack, and a measurement with it', () => {
  const promptRows = [...rows(200, { email: 'unknown' }), ...rows(100, { email: 'a@example.com' })];
  const input = baseInput({ promptRows, index: activityIndexFrom({ promptRows }) });

  const without = findingById(input, 'quality.attribution-gap');
  assert.ok(without);
  assert.equal(without.confidence, 'low', 'without ground truth this can only restate the caveat');
  assert.match(without.detail, /FLOOR/);

  const with_ = findingById({ ...input, metrics: fullMetrics() }, 'quality.attribution-gap');
  assert.ok(with_);
  assert.equal(with_.confidence, 'high');
  assert.ok(
    with_.evidence.some((e) => /gallery|session-keyed/i.test(e.label)),
    'with the pack it should show the session-keyed figure beside the log figure',
  );
});

test('a missing metrics pack is itself reported, not silently absorbed', () => {
  const f = findingById(baseInput({ metrics: null }), 'quality.metrics-unavailable');
  assert.ok(f, 'the tab must say when half its ground truth is missing');
  assert.equal(findingById(baseInput({ metrics: fullMetrics() }), 'quality.metrics-unavailable'), null);
});

test('a log near its ceiling is reported, because the failure is silent', () => {
  const metrics = fullMetrics({
    logs: [
      { name: 'email_open_logs.csv', bytes: 3.9 * 1024 * 1024, exists: true, ceiling: 4 * 1024 * 1024 },
      { name: 'prompt_logs.csv', bytes: 1024, exists: true, ceiling: null },
    ],
  });
  const f = findingById(baseInput({ metrics }), 'quality.log-ceilings');
  assert.ok(f);
  assert.ok(f.evidence.some((e) => e.label === 'email_open_logs.csv'));
  assert.match(f.action, /Do not truncate prompt_logs/, 'truncating it would move a public counter');
});

test('a healthy log set produces no ceiling finding', () => {
  const metrics = fullMetrics({ logs: [{ name: 'prompt_logs.csv', bytes: 5000, exists: true, ceiling: 64 * 1024 * 1024 }] });
  assert.equal(findingById(baseInput({ metrics }), 'quality.log-ceilings'), null);
});

// ── Copy ────────────────────────────────────────────────────────────────────

test('no finding says "1 things" — counts of one are pluralised correctly', () => {
  // Caught by eye in the browser, not by any assertion: a card read "1 trial
  // welcome emails have gone out". Every rule interpolates a count into prose, so
  // the singular case is reachable in a dozen places and only shows up on the one
  // dataset where the count happens to be 1 — exactly the dataset a small or new
  // deployment has. This sweeps a fixture built to make as many counts as possible
  // equal one.
  const promptRows = [
    ...rows(200, { status: 'ok' }, NOW - 3 * DAY),
    promptRow({ status: 'failed', error: 'E_ONE', at: NOW }),
  ];
  const input = baseInput({
    promptRows,
    index: activityIndexFrom({ promptRows }),
    users: [
      user({ id: 'p1', email: 'one@example.com', plan: 'pro', stripeSubscriptionId: 'sub_1', lastStagedAt: new Date(NOW - DAY).toISOString() }),
      user({ id: 'g1', email: 'comp@example.com', plan: 'pro', proGrantExpiresAt: new Date(NOW + 2 * DAY).toISOString() }),
      ...Array.from({ length: 20 }, (_, i) => user({ id: `u${i}`, email: `u${i}@example.com` })),
    ],
    enterprise: [
      { domain: 'a.com', companyName: 'A', status: 'active', usageCount: 400 },
      { domain: 'b.com', companyName: 'B', status: 'active', usageCount: 1 },
    ],
    metrics: fullMetrics({
      shares: { minted: 12, viewed: 1, views: 1, revoked: 1, lastViewedAt: NOW },
      health: { stuckStripeEvents: 1, stripeReclaimMs: 300000, tombstoneBacklog: 1, tombstonesFailing: 1, lastTombstoneError: 'x' },
      logs: [{ name: 'email_open_logs.csv', bytes: 3.9 * 1024 * 1024, exists: true, ceiling: 4 * 1024 * 1024 }],
    }),
  });

  // Also run the trial-email case, which is the one that actually shipped wrong.
  const trialInput = baseInput({
    users: [user({
      plan: 'pro',
      stripeSubscriptionId: 'sub_1',
      lastStagedAt: new Date(NOW - DAY).toISOString(),
      trialLifecycle: { startAt: new Date(NOW - 20 * DAY).toISOString(), sent: { welcome: 'x', ending: null } },
    })],
  });

  // "1 …up to three words… <plural noun>", because the count and the noun are
  // rarely adjacent — the sentence that shipped wrong was "1 trial welcome
  // emails", which a `1 (emails)` pattern misses entirely.
  //
  // `(?!of\b)` is the one exclusion that matters: "1 of 150 renders failed" is
  // correct English and would otherwise be flagged on every small dataset.
  const BAD = /\b1 (?!of\b)(?:\w+ ){0,3}(renders|accounts|emails|links|files|domains|checks|things|reminders|grants|codes|generations|blobs)\b/;

  // The guard is only worth having if it catches the sentence that got through.
  // Asserted directly, because a regex that matches nothing passes the sweep below
  // exactly as happily as correct copy does.
  assert.match('1 trial welcome emails have gone out', BAD, 'the pattern must catch the bug it was written for');
  assert.match('All 1 paying accounts have used the product', BAD);
  assert.doesNotMatch('60 of 150 Kitchen renders failed', BAD, 'a correct "N of M" must not be flagged');
  assert.doesNotMatch('1 render failed today', BAD, 'a correct singular must not be flagged');
  assert.doesNotMatch('1 paying account has never used the product', BAD);

  for (const bag of [input, trialInput]) {
    for (const f of runFindings(bag).findings) {
      const prose = [f.title, f.detail, f.action].join(' ');
      const hit = prose.match(BAD);
      assert.equal(hit, null, `${f.id} wrote "${hit && hit[0]}" — pluralise the singular case`);
    }
  }
});

test('a verb agrees with its count of one', () => {
  const trialInput = baseInput({
    users: [user({
      plan: 'pro',
      trialLifecycle: { startAt: new Date(NOW - 20 * DAY).toISOString(), sent: { welcome: 'x', ending: null } },
    })],
  });
  const f = findingById(trialInput, 'revenue.trial-ending-unsent');
  assert.ok(f);
  assert.match(f.detail, /1 trial welcome email has gone out/, 'the exact sentence that shipped wrong');
});

// ── The PII boundary ────────────────────────────────────────────────────────

test('no email ever reaches a rendered string — only the accounts array', () => {
  // Failure mode 3, and the assertion that makes the brief's redaction a
  // belt-and-braces measure rather than the only control. A rule that
  // interpolated an address into its title would produce a card that looks fine
  // and a prompt that leaks.
  const users = [
    user({ id: 'p1', email: 'dana@example.com', plan: 'pro', stripeSubscriptionId: 'sub_1' }),
    user({ id: 'p2', email: 'marcus@example.com', plan: 'pro', proGrantExpiresAt: new Date(NOW + 2 * DAY).toISOString() }),
    ...Array.from({ length: 30 }, (_, i) => user({ id: `f${i}`, email: `free${i}@example.com`, usageCount: 49 })),
  ];
  const promptRows = rows(300, { email: 'heavy@example.com' });
  const input = baseInput({
    users,
    promptRows,
    index: activityIndexFrom({ promptRows }),
    metrics: fullMetrics(),
    enterprise: [{ domain: 'acme.com', companyName: 'Acme', status: 'active', usageCount: 0 }],
  });

  const { findings } = runFindings(input);
  assert.ok(findings.length > 5, 'the fixture should exercise plenty of rules');

  for (const f of findings) {
    // Everything a card renders as prose, minus the accounts array the brief drops.
    const rendered = [f.title, f.detail, f.action, ...f.evidence.map((e) => `${e.label} ${e.value}`)].join(' ');
    assert.ok(
      !/[\w.+-]+@[\w-]+\.[\w.]+/.test(rendered),
      `${f.id} put an email address in its rendered text: ${rendered.slice(0, 200)}`,
    );
  }

  // And the mechanism the cards DO use is present, so the sweep above is not
  // passing merely because no rule listed anybody.
  const atRisk = findings.find((f) => f.id === 'revenue.at-risk-paying');
  assert.ok(atRisk && atRisk.accounts && atRisk.accounts.length, 'names should still reach the card, via accounts');
  assert.ok(atRisk.accounts.every((a) => a.email && a.note), 'each listed account needs a name and a reason');
});

// ── Fixtures used above ─────────────────────────────────────────────────────

/** A complete metrics pack, matching what GET /api/admin/metrics serves. */
function fullMetrics(over = {}) {
  return {
    generatedAt: NOW,
    renders: {
      total: 320, ok: 300, failed: 20, pending: 0, evicted: 0, distinctUsers: 12,
      firstAt: NOW - 90 * DAY, lastAt: NOW,
      bySource: [{ source: 'interior', total: 320, ok: 300, failed: 20 }],
      last30d: { total: 100, failed: 5, users: 8 },
      last7d: { total: 30, failed: 1, users: 5 },
      perUser: { accounts: 12, p50: 8, p90: 40, max: 90, top: [{ userId: 'u1', renders: 90 }] },
    },
    accounts: { total: 32, withLiveSession: 9, pendingVerification: 1 },
    storage: { blobs: 640, bytes: 2 * 1024 * 1024 * 1024, refCount: 12, refBytes: 4096, topAccounts: [{ userId: 'u1', bytes: 1024, blobs: 4 }] },
    shares: { minted: 30, viewed: 20, views: 140, revoked: 1, lastViewedAt: NOW - DAY },
    health: { stuckStripeEvents: 0, stripeReclaimMs: 5 * 60 * 1000, tombstoneBacklog: 0, tombstonesFailing: 0, lastTombstoneError: null },
    logs: [{ name: 'prompt_logs.csv', bytes: 5000, exists: true, ceiling: 64 * 1024 * 1024 }],
    ...over,
  };
}

/** A dataset with several problems at once, for the sweeps that need variety. */
function messyInput() {
  const promptRows = [
    ...rows(300, { status: 'ok', drift: 'no' }),
    ...Array.from({ length: 60 }, (_, i) => promptRow({ room: 'Kitchen', status: 'failed', error: 'E_K', at: NOW - i * 3600e3 })),
    ...rows(50, { email: 'unknown' }),
  ];
  return baseInput({
    promptRows,
    index: activityIndexFrom({ promptRows }),
    users: [
      user({ id: 'p1', email: 'quiet@example.com', plan: 'pro', stripeSubscriptionId: 'sub_1' }),
      ...Array.from({ length: 20 }, (_, i) => user({ id: `u${i}`, email: `u${i}@example.com` })),
    ],
    enterprise: [
      { domain: 'big.com', companyName: 'Big', status: 'active', usageCount: 500 },
      { domain: 'small.com', companyName: 'Small', status: 'active', usageCount: 1 },
    ],
    metrics: fullMetrics({
      shares: { minted: 40, viewed: 2, views: 5, revoked: 0, lastViewedAt: NOW - 30 * DAY },
      health: { stuckStripeEvents: 3, stripeReclaimMs: 300000, tombstoneBacklog: 12, tombstonesFailing: 5, lastTombstoneError: 'AccessDenied' },
    }),
  });
}
