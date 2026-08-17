// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/status-panel.js.
//
// The formatters are pure and cheap to pin, and two of them are the kind of thing
// that looks right in review and is wrong in production:
//   - the datetime-local conversions. `toISOString()` is UTC, so the obvious
//     implementation posts every incident offset by the operator's timezone — an
//     hour or five off, with nothing on screen looking broken.
//   - fmtPct truncates rather than rounds, because a status page that renders 99.97%
//     as "100%" is lying about the one number it exists to publish.
//
// The rendering half is asserted through the same fake DOM the other admin suites
// use, driving the real island against a stub `apiSend`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, makeEl } from '../../helpers/admin-dom.js';

const HOUR = 60 * 60 * 1000;

const dom = makeDom();
globalThis.document = /** @type {any} */ ({
  get body() { return dom.body; },
  createElement: (tag) => dom.createElement(tag),
  createTextNode: (t) => dom.createTextNode(t),
  getElementById: (id) => dom.getElementById(id),
  querySelector: (s) => dom.querySelector(s),
  querySelectorAll: (s) => dom.querySelectorAll(s),
  visibilityState: 'visible',
});
globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => { fn(); return 1; });
globalThis.confirm = /** @type {any} */ (() => true);

const {
  createStatusPanel, fmtDuration, fmtAgo, fmtPct, toLocalInputValue, fromLocalInputValue,
} = await import('../../../public/scripts/admin/status-panel.js');

// ---- Formatters ------------------------------------------------------------

test('durations read as durations at every scale', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(90_000), '1m 30s');
  assert.equal(fmtDuration(2 * HOUR + 5 * 60_000), '2h 5m');
  assert.equal(fmtDuration(26 * HOUR), '1d 2h');
});

test('a percentage is truncated, never rounded up', () => {
  // 99.999% must not render as 100%: "no downtime" and "nearly no downtime" are
  // different claims, and only one of them is checkable.
  assert.equal(fmtPct(99.999), '99.99%');
  assert.equal(fmtPct(100), '100.00%');
  assert.equal(fmtPct(null), '—', 'no coverage is not zero uptime');
});

test('"ago" degrades by unit, and null is never rather than now', () => {
  assert.equal(fmtAgo(null), 'never');
  assert.equal(fmtAgo(5_000), '5s ago');
  assert.equal(fmtAgo(5 * 60_000), '5m ago');
  assert.equal(fmtAgo(5 * HOUR), '5h ago');
  assert.equal(fmtAgo(50 * HOUR), '2d ago');
});

test('datetime-local round-trips through LOCAL time, not UTC', () => {
  // The bug this exists to prevent: toISOString() is UTC, so a naive implementation
  // shows (and posts) a time offset by the operator's timezone. Round-tripping is
  // the assertion that holds in every zone the suite might run in.
  const t = new Date(2026, 7, 16, 22, 3, 0).getTime();
  const value = toLocalInputValue(t);
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(fromLocalInputValue(value), t, 'what goes into the field must come back out');

  // The field reads the operator's wall clock, so the string must match it.
  assert.equal(value.slice(11), '22:03', 'the input shows 22:03 because that is what they meant');
});

test('an empty or unparseable date field is null, not NaN', () => {
  // null means "ongoing" to the server; NaN would be a 400 the operator cannot explain.
  assert.equal(fromLocalInputValue(''), null);
  assert.equal(fromLocalInputValue(null), null);
  assert.equal(fromLocalInputValue('not a date'), null);
});

// ---- Rendering -------------------------------------------------------------

const NOW = 1_800_000_000_000;

function snapshot(overrides = {}) {
  return {
    generatedAt: NOW,
    currentState: 'up',
    monitoringSince: NOW - 30 * 24 * HOUR,
    lastBeat: NOW - 12_000,
    lastCheckedMsAgo: 12_000,
    bootCount: 7,
    intervalMs: 60_000,
    totalIncidents: 2,
    windows: {
      '24h': { uptimePct: 100, downMs: 0, monitoredMs: 24 * HOUR, coverage: 1, incidents: 0 },
      '7d': { uptimePct: 99.5, downMs: HOUR, monitoredMs: 7 * 24 * HOUR, coverage: 1, incidents: 1 },
      '30d': { uptimePct: 99.9, downMs: HOUR, monitoredMs: 15 * 24 * HOUR, coverage: 0.5, incidents: 1 },
    },
    buckets: {
      '24h': [{ start: NOW - HOUR, end: NOW, state: 'up', uptimePct: 100, downMs: 0 }],
      '7d': [{ start: NOW - HOUR, end: NOW, state: 'up', uptimePct: 100, downMs: 0 }],
      '30d': [{ start: NOW - HOUR, end: NOW, state: 'nodata', uptimePct: null, downMs: 0 }],
    },
    incidents: [],
    manual: [],
    config: { intervalMs: 60_000, gapThresholdMs: 180_000, retentionDays: 90, storePath: '/data/auth-store.db' },
    ...overrides,
  };
}

/** Drive the island with a scripted server. */
async function mount(data) {
  /** @type {{url: string, method: string, body: any}[]} */
  const sent = [];
  const panel = createStatusPanel({
    apiSend: (url, method, body) => {
      sent.push({ url, method, body });
      if (url === '/api/admin/status') return Promise.resolve(data);
      return Promise.resolve({ ok: true });
    },
  });
  await panel.ensureLoaded();
  return { panel, sent };
}

/** Collect the text of every node in a subtree, the fake DOM's children included. */
function textOf(node, out = []) {
  if (!node) return out;
  if (node.textContent) out.push(node.textContent);
  for (const c of node.children || []) textOf(c, out);
  return out;
}

test('the live card states the caveat the public page cannot', async () => {
  await mount(snapshot());
  const text = textOf(dom.querySelector('#adm-status-body')).join(' ');

  assert.match(text, /Operational/);
  assert.match(text, /Heartbeat 12s ago/);
  assert.match(text, /Boots recorded/);
  assert.match(text, /cannot report an outage while it is down/,
    'the inference the whole number rests on has to be stated where an operator reads it');
});

test('a partly-monitored window says so instead of implying a full one', async () => {
  await mount(snapshot());
  const text = textOf(dom.querySelector('#adm-status-body')).join(' ');
  assert.match(text, /only 50% of this window monitored/,
    '99.9% over a half-observed month is not the same claim as 99.9% over a month');
  assert.match(text, /full window monitored/, 'and a complete one says that too, so silence is never ambiguous');
});

test('all three graphs are drawn — the 30-day one is the point of this view', async () => {
  await mount(snapshot());
  const text = textOf(dom.querySelector('#adm-status-body')).join(' ');
  for (const label of ['Last 24 hours', 'Last 7 days', 'Last 30 days']) {
    assert.ok(text.includes(label), `${label} graph missing`);
  }
});

test('the incident log separates what was detected from what was posted', async () => {
  await mount(snapshot({
    incidents: [
      { source: 'manual', id: 'm1', start: NOW - HOUR, end: null, durationMs: HOUR, cause: 'Upstream outage', ongoing: true, affectsUptime: true },
      { source: 'auto', start: NOW - 5 * HOUR, end: NOW - 4 * HOUR, durationMs: HOUR, cause: 'downtime detected on restart (missed heartbeats)', ongoing: false, affectsUptime: true },
    ],
  }));

  const text = textOf(dom.querySelector('#adm-inc-table')).join(' ');
  assert.match(text, /Upstream outage/);
  assert.match(text, /Posted/);
  assert.match(text, /Detected/);
  assert.match(text, /Ongoing/);
  assert.match(textOf(dom.querySelector('#adm-inc-count')).join(' '), /1 posted by hand/);
});

test('only posted incidents get actions — a detected gap is not editable', async () => {
  await mount(snapshot({
    incidents: [
      { source: 'auto', start: NOW - 5 * HOUR, end: NOW - 4 * HOUR, durationMs: HOUR, cause: 'missed heartbeats', ongoing: false, affectsUptime: true },
    ],
  }));
  const buttons = textOf(dom.querySelector('#adm-inc-table')).filter((t) => t === 'Resolve' || t === 'Delete');
  assert.deepEqual(buttons, [], 'a heartbeat gap is a measurement; there is nothing to resolve or delete');
});

test('an ongoing incident lights the rail from every other tab', async () => {
  const dot = makeEl('span');
  dot.id = 'tc-status';
  dot.setAttribute('hidden', 'hidden');
  dom.byId['tc-status'] = dot;

  await mount(snapshot({
    incidents: [{ source: 'manual', id: 'm1', start: NOW - HOUR, end: null, durationMs: HOUR, cause: 'Live', ongoing: true, affectsUptime: true }],
  }));
  assert.equal(dot.getAttribute('hidden'), null, 'a live incident must be visible without opening the tab');

  await mount(snapshot({ incidents: [] }));
  assert.equal(dot.getAttribute('hidden'), 'hidden', 'and the dot clears when nothing is open');
});

test('an empty log says nothing happened rather than rendering an empty table', async () => {
  await mount(snapshot({ incidents: [] }));
  assert.match(textOf(dom.querySelector('#adm-inc-table')).join(' '), /No incidents recorded/);
});

test('a failed load reports the reason instead of an empty panel', async () => {
  const panel = createStatusPanel({ apiSend: () => Promise.reject(new Error('HTTP 503')) });
  dom.querySelector('#adm-status-body').innerHTML = '';
  await panel.ensureLoaded();
  assert.match(textOf(dom.querySelector('#adm-status-body')).join(' '), /Could not load server status: HTTP 503/);
});
