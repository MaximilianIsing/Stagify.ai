// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin/access.js.
//
// Three things are worth pinning here, and none of them is a pixel.
//
//   1. **The lazy contract.** Wired into admin.js like Referrals, Blog and API
//      usage: fetch on first tab open, invalidate on Refresh and on sign-out.
//      Sign-out matters more on this panel than anywhere else — it holds the
//      addresses and devices of the people who administer the site, and leaving
//      them painted on the screen after the operator signs out would be the one
//      thing this tab must never do.
//   2. **A collapsed burst must read as one event with a count.** The store folds
//      repeats to keep a scan from flooding the table; if the panel rendered `hits`
//      as a plain row, that compression would silently become under-reporting, and
//      a 400-attempt burst would look like a single curious visitor.
//   3. **Silence and "unknown" must be honest.** A fresh install has no rows, and an
//      unresolved location is an em dash — never a zero, and never a blank that
//      reads as "nowhere".
//
// The same hand-rolled fake DOM as the other admin suites (no jsdom).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom } from '../../helpers/admin-dom.js';

const dom = makeDom();

globalThis.document = /** @type {any} */ ({
  get body() { return dom.body; },
  createElement: (tag) => dom.createElement(tag),
  createTextNode: (t) => dom.createTextNode(t),
  getElementById: (id) => dom.getElementById(id),
  querySelector: (s) => dom.querySelector(s),
  querySelectorAll: (s) => dom.querySelectorAll(s),
});

const { createAccessPanel } = await import('../../../public/scripts/admin/access.js');

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

function payload(overrides = {}) {
  return {
    configured: true,
    generatedAt: NOW,
    limit: 200,
    rows: [
      {
        id: 2, ts: NOW, lastTs: NOW, hits: 1, ip: '198.51.100.4', outcome: 'open',
        reason: '', path: '/admin', ua: '', browser: 'Safari 17', os: 'macOS',
        isBot: false, geo: { city: 'Munich', region: 'Bavaria', country: 'Germany', countryCode: 'DE' },
      },
      {
        id: 1, ts: NOW - 5000, lastTs: NOW - 1000, hits: 12, ip: '203.0.113.9', outcome: 'denied',
        reason: 'bad-key', path: '/promptlogs', ua: 'curl/8.4.0', browser: 'curl', os: '',
        isBot: true, geo: null,
      },
    ],
    summary: {
      totalEvents: 13, opens: 1, signins: 0, denied: 12,
      distinctIps: 2, deniedIps: 1,
      visitors: [
        {
          ip: '198.51.100.4', geo: { city: 'Munich', region: 'Bavaria', country: 'Germany', countryCode: 'DE' },
          events: 1, opens: 1, signins: 0, denied: 0, isBot: false,
          firstSeen: NOW, lastSeen: NOW,
          devices: [{ browser: 'Safari 17', os: 'macOS', hits: 1, lastSeen: NOW }],
        },
        {
          ip: '203.0.113.9', geo: null,
          events: 12, opens: 0, signins: 0, denied: 12, isBot: true,
          firstSeen: NOW - 5000, lastSeen: NOW - 1000,
          devices: [{ browser: 'curl', os: '', hits: 12, lastSeen: NOW - 1000 }],
        },
      ],
    },
    ...overrides,
  };
}

/** Drive the island against a scripted server. */
function mount(body) {
  /** @type {string[]} */
  const urls = [];
  const panel = createAccessPanel({
    apiSend: (url) => {
      urls.push(url);
      return Promise.resolve(typeof body === 'function' ? body(url) : body);
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

/** Let the island's promise chain settle. */
async function settle() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

// ---- The lazy contract -----------------------------------------------------

test('it fetches once, and a second tab open is free', async () => {
  const { panel, urls } = mount(payload());

  panel.ensureLoaded();
  await settle();
  panel.ensureLoaded();
  panel.ensureLoaded();
  await settle();

  assert.deepEqual(urls, ['/api/admin/access-log'], 'one fetch, however often the tab is opened');
});

test('reset re-arms the fetch and blanks what is on screen', async () => {
  const { panel, urls } = mount(payload());
  panel.ensureLoaded();
  await settle();
  assert.ok(bodyText('#adm-access-visitors').includes('198.51.100.4'));

  panel.reset();
  assert.equal(bodyText('#adm-access-visitors'), '', 'addresses must not survive a sign-out on screen');
  assert.equal(bodyText('#adm-access-rows'), '');

  panel.ensureLoaded();
  await settle();
  assert.equal(urls.length, 2, 'and the next open refetches');
});

// ---- Rendering -------------------------------------------------------------

test('a visitor row carries the address, location and device', async () => {
  const { panel } = mount(payload());
  panel.ensureLoaded();
  await settle();

  const text = bodyText('#adm-access-visitors');
  assert.ok(text.includes('198.51.100.4'), 'the address');
  assert.ok(text.includes('Munich, Germany'), 'the location, as one readable line');
  assert.ok(text.includes('Safari 17 on macOS'), 'the device, in words');
});

test('a collapsed burst renders as one row with a count, not as one attempt', async () => {
  const { panel } = mount(payload());
  panel.ensureLoaded();
  await settle();

  const text = bodyText('#adm-access-rows');
  assert.ok(text.includes('×12'), 'the ×12 is what stops the fold becoming under-reporting');
  assert.ok(text.includes('Refused'), 'and it is labelled as a refusal');
  assert.ok(text.includes('wrong access key'), 'with the reason in words, not a code');
});

test('the refused total is called out when it is not zero', async () => {
  const { panel } = mount(payload());
  panel.ensureLoaded();
  await settle();
  assert.ok(bodyText('#adm-access-summary').includes('12 Refused attempts'));
});

test('an unresolved location is an em dash, never blank and never a zero', async () => {
  const { panel } = mount(payload());
  panel.ensureLoaded();
  await settle();
  // The bot visitor has geo: null. "Unknown" is a real answer here — an address
  // that could not be located is not an address located nowhere.
  assert.ok(bodyText('#adm-access-visitors').includes('—'));
});

// ---- Honest emptiness ------------------------------------------------------

test('a console nobody has opened says so, rather than showing zeros', async () => {
  const { panel } = mount(payload({
    rows: [],
    summary: { totalEvents: 0, opens: 0, signins: 0, denied: 0, distinctIps: 0, deniedIps: 0, visitors: [] },
  }));
  panel.ensureLoaded();
  await settle();

  assert.ok(bodyText('#adm-access-visitors').includes('Nobody has opened this console yet'));
  assert.ok(bodyText('#adm-access-rows').includes('No access recorded yet'));
});

test('recording switched off is stated, not disguised as an empty log', async () => {
  // Otherwise the tab would show "nothing happened" when the truth is "nothing is
  // being watched" — the worst possible confusion on a security page.
  const { panel } = mount(payload({ configured: false }));
  panel.ensureLoaded();
  await settle();
  assert.ok(bodyText('#adm-access-summary').includes('switched off'));
});

test('a failed load says so instead of leaving a spinner', async () => {
  const panel = createAccessPanel({ apiSend: () => Promise.reject(new Error('403')) });
  panel.ensureLoaded();
  await settle();
  assert.ok(bodyText('#adm-access-rows').includes('Could not load the access log'));
});
