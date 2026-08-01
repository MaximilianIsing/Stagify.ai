// Tier: frontend island logic (DOM-stubbed) — the Listing Studio's "Share with your
// client" panel (public/scripts/projects/share-panel.js), mounted against a fake document
// and driven the way a browser drives it: dispatch at the element the handler was attached
// to, then read what changed.
//
// Same house style as test/frontend/projects/studio.test.js — no jsdom, the shared
// element factory from test/helpers/admin-dom.js, real modules everywhere else. In
// particular the CONFIRM DIALOG IS THE REAL ONE (../../../public/scripts/projects/dialog.js)
// and the STORE IS THE REAL ONE, because "revoke asks first" is a claim about the page's
// shared dialog and a stub `ask` would only prove that this file calls a function it
// invented.
//
// WHAT IS ACTUALLY WORTH PINNING HERE:
//
//  1. THE ADDRESS SURVIVES EXACTLY ONE RESPONSE. The share token is hashed at rest, so
//     `POST …/share` is the only place the plaintext URL ever exists. The reload test
//     re-mounts with ONLY the GET response and asserts the minted URL string appears
//     NOWHERE in the document — not in a value, not in text, not in innerHTML. That is the
//     assertion that fails the day someone "helpfully" caches it in localStorage or
//     reconstructs it from the share id, which is the whole hazard of this feature.
//  2. COPY COPIES THE URL, BYTE FOR BYTE. A copy button that copies a truncated or
//     re-derived address is worse than none: the operator will paste it into an email and
//     find out from the client.
//  3. DECLINING THE CONFIRM DOES NOTHING. Not "does something harmless" — nothing. The
//     assertion is on the absence of the DELETE, not on the UI.
//  4. THE SETTINGS BAG GOES WHOLE. The server allowlists and normalizes, so a partial
//     PATCH is how a field quietly reverts. `showBefore` defaults ON.
//  5. A FAILURE LEAVES THE PANEL USABLE. Every remedy here is "press it again", so a
//     failed call must not disable the controls.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEl } from '../../helpers/admin-dom.js';
import { makeProjectsStore } from '../../../public/scripts/projects/state.js';
import { mountConfirmDialog } from '../../../public/scripts/projects/dialog.js';
import {
  EXPIRY_CHOICES,
  SHARE_ELEMENT_IDS,
  defaultShareSettings,
  expirySelectValue,
  isShareLive,
  mountSharePanel,
  normalizeShareSettings,
  shareMetaText,
  shareStatusText,
} from '../../../public/scripts/projects/share-panel.js';

// ── Global ownership ─────────────────────────────────────────────────────────
// Replaced for the whole FILE (the modules under test read them off globalThis at call
// time) and restored afterwards, the way studio.test.js does. `node --test` isolates each
// spec file today, but that is the runner's default, not a property of this file.

const saved = {
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
};

after(() => {
  globalThis.document = saved.document;
  globalThis.window = saved.window;
  globalThis.fetch = saved.fetch;
  globalThis.requestAnimationFrame = saved.requestAnimationFrame;
  if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  else delete (/** @type {any} */ (globalThis)).navigator;
});

// ── Element stub ─────────────────────────────────────────────────────────────

/** @type {string[]} */
const focused = [];

/** @param {string} tag */
function stubEl(tag) {
  const node = /** @type {any} */ (makeEl(tag));
  node.checked = false;
  node.focus = () => focused.push(node.id || node.tagName);
  node.select = () => focused.push(`${node.id}:selected`);
  return node;
}

/** Every id the panel resolves, plus the dialog's and the toast host. */
const PANEL_IDS = [
  ...SHARE_ELEMENT_IDS,
  'pj-confirm', 'pj-confirm-title', 'pj-confirm-body', 'pj-confirm-yes', 'pj-confirm-no',
  'toast-host',
];

/** @type {Record<string, any>} */
let els = {};

/** Rebuild the page. Mirrors the two `hidden` classes projects.html ships. */
function resetDom() {
  els = {};
  for (const id of PANEL_IDS) {
    const node = stubEl('div');
    node.id = id;
    els[id] = node;
  }
  els['pj-share-url-row'].classList.add('hidden');
  els['pj-share-error'].classList.add('hidden');
  els['pj-share-create-label'].textContent = 'Create client link';
  focused.length = 0;
}

// ── Clipboard ────────────────────────────────────────────────────────────────

/** @type {string[]} */
const copied = [];

/**
 * Install a clipboard. `null` removes `navigator` entirely, which is the insecure-origin
 * case the manual fallback exists for.
 * @param {null|{ writeText: (value: string) => Promise<void> }} clipboard
 */
function setClipboard(clipboard) {
  Object.defineProperty(globalThis, 'navigator', {
    value: clipboard === null ? undefined : { clipboard },
    configurable: true,
    writable: true,
  });
}

const workingClipboard = {
  writeText: async (/** @type {string} */ value) => {
    copied.push(String(value));
  },
};

// ── Network ──────────────────────────────────────────────────────────────────

/** @type {Array<{ method: string, path: string, body: any }>} */
const requests = [];
/** @type {{ status: number, payload: any }|null} */
let failNext = null;

const LIVE_SHARE = {
  id: 'sh1',
  projectId: 'p1',
  userId: 'u1',
  createdAt: Date.parse('2026-07-20T10:00:00Z'),
  expiresAt: null,
  revokedAt: null,
  viewCount: 3,
  lastViewedAt: Date.parse('2026-07-28T09:00:00Z'),
  settings: { ...defaultShareSettings(), agentName: 'Dana Brook' },
};

const MINTED_URL = 'https://stagify.ai/s/9f2c41ab7de54ee0a1b3c5d7e9f0a2b4';

/** @type {any} */
let shareFixture = null;
/** @type {any} */
let createFixture = null;

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => {
  fn();
  return 1;
});

globalThis.fetch = /** @type {any} */ (
  async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ method, path, body });
    if (failNext) {
      const failure = failNext;
      failNext = null;
      return { ok: false, status: failure.status, json: async () => failure.payload };
    }
    if (!path.endsWith('/share')) return jsonResponse({});
    if (method === 'POST') return jsonResponse(createFixture);
    if (method === 'PATCH') {
      // Echo what was sent, the way the real route answers with the stored row — so the
      // panel's "refill from the response" path is genuinely exercised.
      const base = shareFixture || LIVE_SHARE;
      return jsonResponse({ share: { ...base, settings: body.settings } });
    }
    if (method === 'DELETE') return jsonResponse({ ok: true, revoked: 1 });
    return jsonResponse({ share: shareFixture, history: [] });
  }
);

// ── document / window ────────────────────────────────────────────────────────

globalThis.document = /** @type {any} */ ({
  documentElement: stubEl('html'),
  body: stubEl('body'),
  getElementById: (/** @type {string} */ id) => els[id] || null,
  createElement: (/** @type {string} */ tag) => stubEl(tag),
  addEventListener: () => {},
});

globalThis.window = /** @type {any} */ ({
  StagifyAuth: { getToken: () => 'tok_session' },
  addEventListener: () => {},
});

// ── Harness helpers ──────────────────────────────────────────────────────────

/** Let every queued microtask and resolved fetch settle. */
async function flush() {
  for (let i = 0; i < 14; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** @type {any} */
let panel = null;

/**
 * Mount the panel and (unless told otherwise) open a listing, which is what triggers the
 * GET. Returns the store and the real dialog so a test can drive both.
 * @param {{ project?: any }} [opts]
 */
async function mountPanel(opts = {}) {
  const project = 'project' in opts ? opts.project : { id: 'p1', title: 'Rosedale', address: '14 Rosedale Ave' };
  resetDom();
  requests.length = 0;
  copied.length = 0;
  const store = makeProjectsStore();
  const dialog = mountConfirmDialog({
    root: els['pj-confirm'],
    title: els['pj-confirm-title'],
    body: els['pj-confirm-body'],
    yes: els['pj-confirm-yes'],
    no: els['pj-confirm-no'],
  });
  panel = mountSharePanel({ store, ask: dialog.ask });
  if (project) {
    store.set({ project });
    await flush();
  }
  return { store, dialog };
}

// THE LEAK GUARD. A primed-but-unconsumed `failNext` is the classic cross-test bleed in
// this suite's shape: the next mount's very first GET eats it and fails for no reason the
// failing test names. Everything mutable resets here, not only in the mount helper.
afterEach(() => {
  failNext = null;
  shareFixture = null;
  createFixture = null;
  setClipboard(workingClipboard);
  if (panel && typeof panel.destroy === 'function') panel.destroy();
  panel = null;
});

setClipboard(workingClipboard);

/** Every string the document is currently showing or holding, from every node. */
function domDump() {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {any} */ node) => {
    if (!node) return;
    if (node.textContent) out.push(String(node.textContent));
    if (node.value) out.push(String(node.value));
    if (node.innerHTML) out.push(String(node.innerHTML));
    for (const child of node.children || []) walk(child);
  };
  for (const node of Object.values(els)) walk(node);
  return out.join('\n');
}

/** @param {string} method @param {RegExp} pattern */
const sent = (method, pattern) =>
  requests.filter((request) => request.method === method && pattern.test(request.path));

// ── The pure helpers ─────────────────────────────────────────────────────────

test('the status sentence distinguishes "we lost the address" from "there is no link"', () => {
  assert.match(shareStatusText(null, false), /No client link yet/);
  assert.match(shareStatusText(LIVE_SHARE, true), /only time we can show you the address/);
  // THE BRANCH THIS FEATURE EXISTS FOR: a live link whose address we no longer hold. It
  // must claim the link works AND explain why it cannot be shown, or it reads as an outage.
  const reloaded = shareStatusText(LIVE_SHARE, false);
  assert.match(reloaded, /active/);
  assert.match(reloaded, /only show the address once/);
  assert.match(reloaded, /create a new link/i);
  assert.match(shareStatusText({ ...LIVE_SHARE, revokedAt: 1 }, false), /revoked/);
  assert.match(
    shareStatusText({ ...LIVE_SHARE, expiresAt: 10 }, false, 20),
    /expired/,
  );
});

test('liveness separates revoked from expired, and absence from either', () => {
  assert.equal(isShareLive(null), false);
  assert.equal(isShareLive(LIVE_SHARE), true);
  assert.equal(isShareLive({ ...LIVE_SHARE, revokedAt: 5 }), false);
  assert.equal(isShareLive({ ...LIVE_SHARE, expiresAt: 10 }, 20), false);
  assert.equal(isShareLive({ ...LIVE_SHARE, expiresAt: 100 }, 20), true);
});

test('the meta line states a zero view count rather than omitting it', () => {
  const meta = shareMetaText({ ...LIVE_SHARE, viewCount: 0, lastViewedAt: null });
  assert.match(meta, /Not opened yet/);
  assert.match(meta, /No expiry/);
  assert.match(shareMetaText({ ...LIVE_SHARE }), /Opened 3 time\(s\)/);
  assert.equal(shareMetaText(null), '');
});

test('the expiry select reads back the window that was CHOSEN, not the time left', () => {
  const created = Date.parse('2026-07-20T10:00:00Z');
  assert.equal(expirySelectValue({ ...LIVE_SHARE, createdAt: created, expiresAt: created + 30 * 86400000 }), '30');
  assert.equal(expirySelectValue({ ...LIVE_SHARE, expiresAt: null }), '');
  // A window nobody could have picked here is not rounded into a bucket — the meta line
  // still states the real date.
  assert.equal(expirySelectValue({ ...LIVE_SHARE, createdAt: created, expiresAt: created + 5 * 86400000 }), '');
  assert.deepEqual(EXPIRY_CHOICES, [null, 7, 30, 90]);
});

test('settings normalize with showBefore defaulting ON, not off', () => {
  assert.equal(normalizeShareSettings(null).showBefore, true);
  assert.equal(normalizeShareSettings({}).showBefore, true);
  assert.equal(normalizeShareSettings({ showBefore: false }).showBefore, false);
  assert.equal(normalizeShareSettings({ headline: null }).headline, '');
});

// ── The panel ────────────────────────────────────────────────────────────────

test('without its markup the panel is inert rather than throwing', async () => {
  els = {};
  const store = makeProjectsStore();
  const handle = mountSharePanel({ store, ask: () => assert.fail('no dialog expected') });
  store.set({ project: { id: 'p1', title: 'Rosedale', address: '' } });
  await flush();
  assert.equal(requests.length, 0, 'an unmounted panel must not talk to the API');
  handle.destroy();
});

test('a listing with no link shows the empty state and the toggle defaults on', async () => {
  await mountPanel();
  assert.equal(sent('GET', /\/api\/projects\/p1\/share$/).length, 1);
  assert.match(els['pj-share-status'].textContent, /No client link yet/);
  assert.equal(els['pj-share-meta'].textContent, '');
  assert.ok(els['pj-share-url-row'].classList.contains('hidden'), 'no address row without an address');
  assert.equal(els['pj-share-before'].checked, true, 'before/after is on unless turned off');
  assert.equal(els['pj-share-create'].disabled, false);
  assert.equal(els['pj-share-create-label'].textContent, 'Create client link');
  // Nothing to revoke and nothing to reconfigure until a link exists.
  assert.equal(els['pj-share-revoke'].disabled, true);
  assert.equal(els['pj-share-save'].disabled, true);
});

test('minting renders the address, and Copy copies exactly it', async () => {
  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: false };
  await mountPanel();

  els['pj-share-create'].dispatch('click');
  await flush();

  assert.equal(sent('POST', /\/share$/).length, 1, 'the mint is a POST');
  assert.equal(els['pj-share-url'].value, MINTED_URL);
  assert.ok(!els['pj-share-url-row'].classList.contains('hidden'), 'the address row is shown');
  assert.match(els['pj-share-status'].textContent, /only time we can show you the address/);
  // The same button rotates from here on, and says so.
  assert.equal(els['pj-share-create-label'].textContent, 'Create new link');
  assert.equal(els['pj-share-revoke'].disabled, false);

  els['pj-share-copy'].dispatch('click');
  await flush();
  assert.deepEqual(copied, [MINTED_URL], 'the clipboard gets the URL byte for byte');
  assert.match(els['pj-share-live'].textContent, /copied/i, 'and the live region says so');
});

test('Copy falls back to selecting the field when the clipboard is unavailable', async () => {
  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: false };
  await mountPanel();
  els['pj-share-create'].dispatch('click');
  await flush();

  // The insecure-origin case: no navigator at all. The address must still be reachable —
  // it is the only one the operator will ever be shown.
  setClipboard(null);
  els['pj-share-copy'].dispatch('click');
  await flush();
  assert.deepEqual(copied, [], 'nothing was written');
  assert.ok(focused.includes('pj-share-url:selected'), 'the field is selected for a manual copy');
  assert.match(els['pj-share-live'].textContent, /Ctrl or Cmd/);
  assert.equal(els['pj-share-url'].value, MINTED_URL, 'and the address is still on screen');
});

test('Copy survives a clipboard that REJECTS, not only one that is missing', async () => {
  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: false };
  await mountPanel();
  els['pj-share-create'].dispatch('click');
  await flush();

  setClipboard({ writeText: async () => { throw new Error('not focused'); } });
  els['pj-share-copy'].dispatch('click');
  await flush();
  assert.ok(focused.includes('pj-share-url:selected'));
  assert.match(els['pj-share-live'].textContent, /Ctrl or Cmd/);
});

test('after a reload the panel reports the ACTIVE link and shows no address at all', async () => {
  // First session: mint, so the URL genuinely existed in this process.
  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: false };
  await mountPanel();
  els['pj-share-create'].dispatch('click');
  await flush();
  assert.ok(domDump().includes(MINTED_URL), 'precondition: the address was on screen');
  panel.destroy();

  // Second session: a fresh mount that only ever sees the GET. The token is hashed at
  // rest, so there is no way back to the address — and the panel must not pretend there is.
  shareFixture = LIVE_SHARE;
  createFixture = null;
  await mountPanel();

  assert.equal(sent('POST', /\/share$/).length, 0, 'a reload must not silently re-mint');
  assert.match(els['pj-share-status'].textContent, /active/);
  assert.match(els['pj-share-status'].textContent, /only show the address once/);
  assert.match(els['pj-share-status'].textContent, /create a new link/i);
  assert.match(els['pj-share-meta'].textContent, /Opened 3 time\(s\)/);

  assert.equal(els['pj-share-url'].value, '', 'the address field is empty');
  assert.ok(els['pj-share-url-row'].classList.contains('hidden'), 'and its row is hidden');
  assert.equal(els['pj-share-copy'].disabled, true, 'there is nothing to copy');
  // THE ASSERTION THIS WHOLE FILE IS FOR: not merely "the field is empty" but "the string
  // is nowhere in the document" — no cached copy, no reconstruction, no tooltip.
  assert.ok(
    !domDump().includes(MINTED_URL),
    'the minted URL must not survive a reload anywhere in the DOM'
  );
  // The controls that DO still work are offered: rotation and revocation.
  assert.equal(els['pj-share-create'].disabled, false);
  assert.equal(els['pj-share-create-label'].textContent, 'Create new link');
  assert.equal(els['pj-share-revoke'].disabled, false);
});

test('the minted address does not follow the operator to another listing', async () => {
  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: false };
  const { store } = await mountPanel();
  els['pj-share-create'].dispatch('click');
  await flush();
  assert.equal(els['pj-share-url'].value, MINTED_URL);

  shareFixture = null;
  store.set({ project: { id: 'p2', title: 'Bathurst', address: '9 Bathurst St' } });
  await flush();
  assert.equal(els['pj-share-url'].value, '', 'a different listing, a different link');
  assert.ok(!domDump().includes(MINTED_URL));
  assert.match(els['pj-share-status'].textContent, /No client link yet/);
});

test('revoking asks via the SHARED dialog, and declining does nothing', async () => {
  shareFixture = LIVE_SHARE;
  await mountPanel();

  els['pj-share-revoke'].dispatch('click');
  // The page's one confirm dialog — not window.confirm, and not a second instance.
  assert.ok(els['pj-confirm'].classList.contains('is-open'), 'the shared dialog opened');
  assert.equal(els['pj-confirm'].getAttribute('aria-hidden'), 'false');
  assert.match(els['pj-confirm-title'].textContent, /Revoke this client link/);
  assert.match(els['pj-confirm-body'].textContent, /stops being able to open/);
  assert.equal(els['pj-confirm-yes'].textContent, 'Revoke link');

  els['pj-confirm-no'].dispatch('click');
  await flush();
  assert.equal(sent('DELETE', /\/share$/).length, 0, 'declining sends NOTHING');
  assert.ok(!els['pj-confirm'].classList.contains('is-open'));
  assert.equal(els['pj-share-revoke'].disabled, false, 'and the link is still live');
  assert.match(els['pj-share-status'].textContent, /active/);

  // Accepting does.
  els['pj-share-revoke'].dispatch('click');
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  assert.equal(sent('DELETE', /\/api\/projects\/p1\/share$/).length, 1);
  assert.match(els['pj-share-status'].textContent, /No client link yet/);
  assert.equal(els['pj-share-revoke'].disabled, true);
  assert.equal(els['pj-share-save'].disabled, true);
});

test('rotating an existing link confirms first — it breaks the address already sent', async () => {
  shareFixture = LIVE_SHARE;
  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: true };
  await mountPanel();

  els['pj-share-create'].dispatch('click');
  assert.ok(els['pj-confirm'].classList.contains('is-open'));
  els['pj-confirm-no'].dispatch('click');
  await flush();
  assert.equal(sent('POST', /\/share$/).length, 0, 'declining mints nothing');

  els['pj-share-create'].dispatch('click');
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  assert.equal(sent('POST', /\/share$/).length, 1);
  assert.equal(els['pj-share-url'].value, MINTED_URL);
});

test('Save sends the WHOLE settings bag plus the expiry window', async () => {
  shareFixture = LIVE_SHARE;
  await mountPanel();
  assert.equal(els['pj-share-save'].disabled, false, 'a live link is configurable');

  els['pj-share-before'].checked = false;
  els['pj-share-headline'].value = '  Newly staged — 14 Rosedale Ave  ';
  els['pj-share-note'].value = 'Walk-through Thursday?';
  els['pj-share-agent-name'].value = 'Dana Brook';
  els['pj-share-agent-email'].value = 'dana@example.com';
  els['pj-share-agent-phone'].value = '+1 416 555 0134';
  els['pj-share-expiry'].value = '30';

  els['pj-share-save'].dispatch('click');
  await flush();

  const [patch] = sent('PATCH', /\/api\/projects\/p1\/share$/);
  assert.ok(patch, 'Save is a PATCH');
  // EVERY key, every time: the route allowlists the bag, so a diff is how a field reverts.
  assert.deepEqual(patch.body.settings, {
    showBefore: false,
    headline: 'Newly staged — 14 Rosedale Ave',
    note: 'Walk-through Thursday?',
    agentName: 'Dana Brook',
    agentEmail: 'dana@example.com',
    agentPhone: '+1 416 555 0134',
  });
  assert.equal(patch.body.expiresInDays, 30);
  // "Never" is an explicit null, not an omitted key — omitting it could not clear an expiry.
  els['pj-share-expiry'].value = '';
  els['pj-share-save'].dispatch('click');
  await flush();
  assert.equal(sent('PATCH', /\/share$/)[1].body.expiresInDays, null);
});

test('the mint carries the settings currently in the form', async () => {
  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: false };
  await mountPanel();
  els['pj-share-headline'].value = 'Sunny two-bed';
  els['pj-share-expiry'].value = '7';
  els['pj-share-create'].dispatch('click');
  await flush();
  const [post] = sent('POST', /\/share$/);
  assert.equal(post.body.settings.headline, 'Sunny two-bed');
  assert.equal(post.body.settings.showBefore, true);
  assert.equal(post.body.expiresInDays, 7);
});

test('a hostile headline and agent name are text, never markup', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const hostileName = '</strong><script>alert(2)</script>';
  shareFixture = {
    ...LIVE_SHARE,
    settings: { ...defaultShareSettings(), headline: hostile, agentName: hostileName },
  };
  await mountPanel();

  // Round-tripped verbatim into form VALUES — a value is never parsed as markup, and
  // escaping it here would corrupt what the operator typed on the next save.
  assert.equal(els['pj-share-headline'].value, hostile);
  assert.equal(els['pj-share-agent-name'].value, hostileName);

  // And nothing anywhere in this panel is built as an HTML string. This is the assertion
  // that fails the day someone swaps a textContent write for an innerHTML one.
  for (const [id, node] of Object.entries(els)) {
    assert.equal(node.innerHTML, '', `${id} must not be filled with an HTML string`);
  }

  els['pj-share-save'].dispatch('click');
  await flush();
  const [patch] = sent('PATCH', /\/share$/);
  assert.equal(patch.body.settings.headline, hostile, 'and it goes back unmangled');
});

test('a failed load surfaces a notice and leaves the panel usable', async () => {
  failNext = { status: 500, payload: { ref: 'abc123' } };
  await mountPanel();

  assert.ok(!els['pj-share-error'].classList.contains('hidden'), 'the notice is shown');
  assert.match(els['pj-share-error'].textContent, /server had a problem/i);
  // NOT disabled. Every remedy on this panel is "press it again", so a failure that locks
  // the controls strands the operator with no way forward.
  assert.equal(els['pj-share-create'].disabled, false);

  createFixture = { share: LIVE_SHARE, token: 'tok', url: MINTED_URL, replaced: false };
  els['pj-share-create'].dispatch('click');
  await flush();
  assert.equal(els['pj-share-url'].value, MINTED_URL, 'and the retry works');
  assert.ok(els['pj-share-error'].classList.contains('hidden'), 'the stale notice is cleared');
});

test('a failed mint keeps the previous state instead of half-applying one', async () => {
  shareFixture = LIVE_SHARE;
  await mountPanel();
  failNext = { status: 429, payload: { error: 'Too many links. Wait a minute.' } };

  els['pj-share-create'].dispatch('click');
  els['pj-confirm-yes'].dispatch('click');
  await flush();

  assert.match(els['pj-share-error'].textContent, /Too many links/);
  assert.equal(els['pj-share-url'].value, '', 'no address was invented');
  assert.match(els['pj-share-status'].textContent, /active/, 'the existing link is still described');
  assert.equal(els['pj-share-create'].disabled, false);
  assert.equal(els['pj-share-revoke'].disabled, false);
});

test('a progress tick does not reload the share or overwrite what is being typed', async () => {
  shareFixture = LIVE_SHARE;
  const { store } = await mountPanel();
  assert.equal(sent('GET', /\/share$/).length, 1);

  els['pj-share-note'].value = 'half-written sentence';
  // The store notifies on every poll tick during a run. Same listing → nothing to redo.
  store.set({ progress: { queued: 1, running: 1, ok: 2, failed: 0, superseded: 0, total: 4 } });
  await flush();

  assert.equal(sent('GET', /\/share$/).length, 1, 'no re-read on a tick');
  assert.equal(els['pj-share-note'].value, 'half-written sentence', 'and no clobbered input');
});
