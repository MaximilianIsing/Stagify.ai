// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/referrals.js.
//
// The Referrals tab turns the server's per-link rollup into the card an operator
// actually reads. What's worth pinning is not the markup but the things a wrong
// panel would misreport:
//   - the shareable URL is built from this page's origin, so the operator copies a
//     link that works (not one hardcoded to production while they're on staging),
//   - a link with zero clicks shows an explicit empty state instead of an
//     axis-less chart that reads as broken,
//   - excluded bot traffic is only mentioned when there IS some — otherwise every
//     card carries a confusing "0 bot hits" chip,
//   - day labels are formatted in UTC, matching the server's buckets. Parsed as
//     local time, '2026-07-01' renders as "Jun 30" for anyone west of Greenwich,
//     silently shifting the whole chart by a day.
//
// Same minimal stub `document` as admin-charts.test.js — no jsdom.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------

function makeEl(tag, ns) {
  return {
    tagName: tag,
    namespaceURI: ns || null,
    className: '',
    textContent: '',
    title: '',
    innerHTML: '',
    style: /** @type {Record<string, string>} */ ({}),
    attrs: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    listeners: /** @type {Record<string, Function[]>} */ ({}),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
}

const host = makeEl('div');
globalThis.document = /** @type {any} */ ({
  createElement: (tag) => makeEl(tag),
  createElementNS: (ns, tag) => makeEl(tag, ns),
  createTextNode: (t) => ({ tagName: '#text', textContent: String(t), children: [] }),
  querySelector: (sel) => (sel === '#adm-referrals' ? host : null),
});
globalThis.location = /** @type {any} */ ({ origin: 'http://127.0.0.1:3000' });

const { createReferralsPanel } = await import('../../../public/scripts/admin/referrals.js');

// ---- Helpers ---------------------------------------------------------------

/** Every node in the rendered tree, depth-first. */
function flatten(node, out = []) {
  out.push(node);
  for (const child of node.children || []) flatten(child, out);
  return out;
}

/** All text anywhere in the tree, joined — the panel's visible content. */
const allText = (node) => flatten(node).map((n) => n.textContent || '').filter(Boolean).join(' | ');

const linkFixture = (over = {}) => ({
  slug: 'columbia',
  label: 'Columbia University',
  note: 'Campus outreach',
  path: '/columbia',
  clicks: 42,
  botHits: 7,
  windowClicks: 12,
  windowDays: 30,
  last7: 5,
  firstClickAt: Date.UTC(2026, 6, 1, 9),
  lastClickAt: Date.UTC(2026, 6, 28, 9),
  series: [
    { date: '2026-07-01', value: 3 },
    { date: '2026-07-02', value: 0 },
    { date: '2026-07-03', value: 9 },
  ],
  referrers: [{ source: 'columbia.edu/housing', value: 8 }],
  ...over,
});

/** Render one payload through the real panel and hand back the rendered tree. */
async function renderPanel(links) {
  host.children = [];
  host.innerHTML = '';
  const panel = createReferralsPanel({ apiSend: async () => ({ days: 30, links }) });
  panel.ensureLoaded();
  await new Promise((r) => setImmediate(r));
  return host;
}

// ---- Tests -----------------------------------------------------------------

test('the copyable URL is built from this page origin, not a hardcoded domain', async () => {
  const tree = await renderPanel([linkFixture()]);
  const urls = flatten(tree).filter((n) => n.className === 'adm-host-url');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].textContent, 'http://127.0.0.1:3000/columbia');
  // el() routes `title` through setAttribute, so on this stub it lands in attrs.
  assert.equal(urls[0].attrs.title, 'http://127.0.0.1:3000/columbia', 'the full URL is hoverable when truncated');
});

test('the headline numbers are all surfaced', async () => {
  const tree = await renderPanel([linkFixture()]);
  const text = allText(tree);
  assert.match(text, /Columbia University/);
  assert.match(text, /Campus outreach/);
  assert.match(text, /42 clicks/, 'lifetime total in the chip');
  assert.match(text, /All time: 42/);
  assert.match(text, /Last 30 days: 12/);
  assert.match(text, /Last 7 days: 5/);
  assert.match(text, /columbia\.edu\/housing/, 'the top referrer is listed');
});

test('excluded bot traffic is reported only when there is some', async () => {
  const withBots = allText(await renderPanel([linkFixture({ botHits: 7 })]));
  assert.match(withBots, /7 bot hits excluded/);

  const clean = allText(await renderPanel([linkFixture({ botHits: 0 })]));
  assert.equal(/bot hits/.test(clean), false, 'no confusing "0 bot hits" chip on a clean link');
});

test('a link with no clicks gets an explicit empty state, not an empty chart', async () => {
  const tree = await renderPanel([
    linkFixture({ clicks: 0, windowClicks: 0, last7: 0, botHits: 0, lastClickAt: null, firstClickAt: null, referrers: [], series: [] }),
  ]);
  const text = allText(tree);
  assert.match(text, /No clicks recorded yet/, 'says so in words');
  assert.match(text, /No referring sites recorded/, 'and explains why the sources list is empty');
  assert.match(text, /Last click: —/);
  assert.equal(
    flatten(tree).some((n) => n.className === 'adm-chart-svg'),
    false,
    'no chart is drawn for a link with nothing to draw',
  );
});

test('day labels are formatted in UTC, matching the server buckets', async () => {
  // Parsed as local time instead, '2026-07-01' renders as "Jun 30" anywhere west of
  // Greenwich and the whole chart silently slides by a day.
  const tree = await renderPanel([linkFixture()]);
  const labels = flatten(tree)
    .flatMap((n) => (n.children || []).filter((c) => c.tagName === '#text'))
    .map((n) => n.textContent);
  assert.ok(labels.some((t) => /Jul 1\b/.test(t)), `expected a "Jul 1" axis label, saw: ${labels.join(', ')}`);
  assert.equal(labels.some((t) => /Jun 30/.test(t)), false, 'no off-by-one-day drift');
});

test('nothing configured renders a message rather than a blank tab', async () => {
  const tree = await renderPanel([]);
  assert.match(allText(tree), /No referral links are configured/);
});

test('a failed fetch reports the error instead of spinning forever', async () => {
  host.children = [];
  const panel = createReferralsPanel({ apiSend: async () => { throw new Error('HTTP 403'); } });
  panel.ensureLoaded();
  await new Promise((r) => setImmediate(r));
  assert.match(allText(host), /Could not load referral stats: HTTP 403/);
});

test('the panel is fetched once, and again after a reset', async () => {
  let calls = 0;
  host.children = [];
  const panel = createReferralsPanel({
    apiSend: async () => { calls += 1; return { links: [linkFixture()] }; },
  });

  panel.ensureLoaded();
  panel.ensureLoaded(); // second tab open — must not refetch
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, 'lazy-loaded once');

  // Refresh and sign-out both go through reset(); the next open must refetch, or
  // the dashboard would keep showing the previous session's numbers.
  panel.reset();
  panel.ensureLoaded();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
});
