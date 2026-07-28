// Tier: frontend island logic (DOM-stubbed) — the admin dashboard's user-facing
// message channel.
//
// The admin dashboard was the last corner of the app still calling native
// alert(): a failed hosted-image delete, a failed log download, and the
// session-expiry notice. Everything else was migrated to scripts/toast.js, so
// these three were modal, unstyled browser dialogs in an otherwise toast-based UI.
//
// This suite pins the migration behaviourally rather than by grepping for the
// string "alert": it runs the REAL toast module against a fake DOM and asserts on
// the element toast.js actually builds — one node per message, `toast--error` for
// the level, `role="alert"` so a screen reader is interrupted. A source scan would
// pass against a toast raised at the wrong severity, or against a call site that
// was deleted rather than converted; this does not.
//
// The session-expiry case is the interesting one. alert() BLOCKS, so the old code
// got "user has read this" for free before signOut() swapped the dashboard for the
// login form. A toast does not block, so the test also proves signOut() ran (dash
// hidden, login shown) with the toast still standing — i.e. the message is not
// racing a navigation, because signOut() never navigates.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------
// Only the surface admin.js, admin/renderers.js, admin/helpers.js#el and
// scripts/toast.js touch. No jsdom, matching the other frontend-island suites.

function makeClassList(node) {
  const parts = () => (node.className || '').split(' ').filter(Boolean);
  const write = (list) => { node.className = list.join(' '); };
  return {
    add(...cls) { const l = parts(); for (const c of cls) if (!l.includes(c)) l.push(c); write(l); },
    remove(...cls) { write(parts().filter((c) => !cls.includes(c))); },
    toggle(c, on) { if (on) this.add(c); else this.remove(c); },
    contains(c) { return parts().includes(c); },
  };
}

function makeEl(tag) {
  const node = {
    tagName: tag,
    id: '',
    className: '',
    textContent: '',
    disabled: false,
    value: '',
    style: /** @type {Record<string, string>} */ ({}),
    dataset: /** @type {Record<string, string>} */ ({}),
    attrs: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    handlers: /** @type {Record<string, Function[]>} */ ({}),
    parent: /** @type {any} */ (null),
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { if (this.parent) this.parent.removeChild(this); this.parent = null; },
    addEventListener(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); },
    click() { for (const fn of this.handlers.click || []) fn.call(this, { target: this }); },
  };
  // innerHTML is a real sink in renderers.js ("" to clear, markup to fill), so the
  // setter must drop the children the way the browser does.
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); node.children.length = 0; },
  });
  node.classList = makeClassList(node);
  return node;
}

/**
 * A document whose `#id` lookups materialise on demand, so a test needs no page
 * markup. getElementById does NOT auto-create — toast.js relies on a genuine miss
 * for '#toast-host' the first time, and on a hit afterwards, which is how we can
 * assert it builds exactly one host.
 */
function makeDom() {
  const byId = /** @type {Record<string, any>} */ ({});
  const body = makeEl('body');
  const register = (node) => { if (node && node.id) byId[node.id] = node; };
  const origAppend = body.appendChild.bind(body);
  body.appendChild = (c) => { register(c); return origAppend(c); };
  return {
    byId,
    body,
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ textContent: String(t), children: [] }),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => {
      if (!sel.startsWith('#')) return null;
      const id = sel.slice(1);
      if (!byId[id]) { const n = makeEl('div'); n.id = id; byId[id] = n; }
      return byId[id];
    },
    querySelectorAll: () => [],
  };
}

// One live `document` whose backing DOM can be swapped between tests. admin.js
// captures elements in its boot IIFE, so its DOM has to outlive the import.
let dom = makeDom();
const setDom = (next) => { dom = next; return next; };

globalThis.document = /** @type {any} */ ({
  get body() { return dom.body; },
  createElement: (tag) => dom.createElement(tag),
  createTextNode: (t) => dom.createTextNode(t),
  getElementById: (id) => dom.getElementById(id),
  querySelector: (s) => dom.querySelector(s),
  querySelectorAll: (s) => dom.querySelectorAll(s),
});
globalThis.location = /** @type {any} */ ({ origin: 'https://stagify.ai' });
globalThis.confirm = () => true;

// The assertion this whole suite exists for: nothing may reach native alert().
/** @type {string[]} */
const alertCalls = [];
globalThis.alert = /** @type {any} */ ((msg) => { alertCalls.push(String(msg)); });

// ---- Toast capture ---------------------------------------------------------
// toast.js schedules with requestAnimationFrame + setTimeout. Both are recorded
// rather than run, so the assertions see the toast at birth and the process is not
// held open by the 4.2s removal timer. requestAnimationFrame does not exist in
// Node, so recording it also models the backgrounded-tab case the module's 50ms
// backstop was written for: the reveal must still be reachable with rAF silent.

/** @type {Function[]} */
let rafQueue = [];
/** @type {{fn: Function, ms: number}[]} */
let timerQueue = [];
globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => { rafQueue.push(fn); return rafQueue.length; });

/** Run `fn` with timers captured instead of scheduled; returns the toast nodes raised. */
async function captureToasts(fn) {
  const realSetTimeout = globalThis.setTimeout;
  rafQueue = [];
  timerQueue = [];
  globalThis.setTimeout = /** @type {any} */ ((cb, ms) => { timerQueue.push({ fn: cb, ms: Number(ms) || 0 }); return timerQueue.length; });
  try {
    await fn();
    // Settle the promise chains the click handlers kick off. setImmediate, not a
    // timer — the timer queue is faked out for the duration of this call.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  const host = dom.getElementById('toast-host');
  return host ? host.children.slice() : [];
}

/** The reveal that toast.js flips one frame (or 50ms) after insertion. */
function runReveals() {
  for (const fn of rafQueue) fn();
  for (const t of timerQueue) if (t.ms === 50) t.fn();
}

function assertErrorToast(toasts, message) {
  assert.equal(toasts.length, 1, `expected exactly one toast, got ${toasts.length}`);
  const [toast] = toasts;
  assert.equal(toast.textContent, message);
  assert.ok(toast.classList.contains('toast--error'), `expected an error-level toast, got className "${toast.className}"`);
  assert.equal(toast.getAttribute('role'), 'alert', 'error toasts must interrupt a screen reader');
  assert.deepEqual(alertCalls, [], 'native alert() must not be called');
}

// ---- Boot admin.js against its own DOM ------------------------------------
// The shell is an IIFE that wires ~15 elements at import time, so its DOM must be
// active before the import and must stay reachable for the session-expiry test.

const adminDom = setDom(makeDom());
globalThis.sessionStorage = /** @type {any} */ ({
  store: /** @type {Record<string, string>} */ ({}),
  getItem(k) { return k in this.store ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
});
/** @type {(url: string) => Promise<any>} */
let fetchImpl = async () => { throw new Error('no fetch stub'); };
globalThis.fetch = /** @type {any} */ ((url) => fetchImpl(String(url)));

await import('../../../public/scripts/admin.js');
const { createRenderers } = await import('../../../public/scripts/admin/renderers.js');

// ---- renderers.js: hosted-image delete ------------------------------------

test('a failed hosted-image delete raises an error toast, not an alert', async () => {
  setDom(makeDom());
  alertCalls.length = 0;

  const ctx = {
    data: { users: [], promptRows: [], chatRows: [], bugRows: [], maskRows: [], contactRows: [], emailOpenRows: [], enterprise: [], hostedImages: [{ id: 'img_1', path: '/i/img_1', originalName: 'kitchen.png', size: 2048, uploadedAt: '2026-07-01T00:00:00.000Z' }] },
    userFilter: 'all', userSortCol: 'created', userSortDir: 'desc',
  };
  const renderers = createRenderers({
    ctx,
    apiSend: () => Promise.reject(new Error('HTTP 500')),
    secureBlobDownload: () => Promise.resolve(),
  });

  renderers.renderHosting();
  const delBtn = findByClass(dom.getElementById('adm-hosting-list'), 'adm-host-del');
  assert.ok(delBtn, 'renderHosting should render a Delete button');

  const toasts = await captureToasts(() => { delBtn.click(); });

  assertErrorToast(toasts, 'Delete failed: HTTP 500');
  assert.equal(delBtn.disabled, false, 'the Delete button must be re-enabled after the failure');
  assert.equal(delBtn.textContent, 'Delete');
});

// ---- renderers.js: log download -------------------------------------------

test('a failed log download raises an error toast, not an alert', async () => {
  setDom(makeDom());
  alertCalls.length = 0;

  const ctx = {
    data: { users: [], promptRows: [], chatRows: [], bugRows: [], maskRows: [], contactRows: [], emailOpenRows: [], enterprise: [], hostedImages: [] },
    userFilter: 'all', userSortCol: 'created', userSortDir: 'desc',
  };
  const renderers = createRenderers({
    ctx,
    apiSend: () => Promise.resolve({}),
    secureBlobDownload: () => Promise.reject(new Error('403')),
  });

  // renderDownloads is private; renderAll is the only door to it. The sibling
  // renderers land on an empty DOM and are swallowed by renderAll's own try/catch.
  const realError = console.error;
  console.error = () => {};
  try { renderers.renderAll(); } finally { console.error = realError; }

  const grid = dom.getElementById('adm-dl-grid');
  const btn = grid.children[0];
  assert.ok(btn, 'renderAll should populate the downloads grid');

  const toasts = await captureToasts(() => { btn.click(); });

  assertErrorToast(toasts, 'Download failed for prompt_logs.csv');
});

// ---- toast delivery --------------------------------------------------------

test('the toast is revealed by the 50ms backstop even when rAF never fires', async () => {
  setDom(makeDom());
  alertCalls.length = 0;

  const ctx = {
    data: { users: [], promptRows: [], chatRows: [], bugRows: [], maskRows: [], contactRows: [], emailOpenRows: [], enterprise: [], hostedImages: [] },
    userFilter: 'all', userSortCol: 'created', userSortDir: 'desc',
  };
  const renderers = createRenderers({ ctx, apiSend: () => Promise.resolve({}), secureBlobDownload: () => Promise.reject(new Error('x')) });
  const realError = console.error;
  console.error = () => {};
  try { renderers.renderAll(); } finally { console.error = realError; }

  const toasts = await captureToasts(() => { dom.getElementById('adm-dl-grid').children[0].click(); });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].classList.contains('toast--show'), false, 'not visible before the reveal runs');

  rafQueue = []; // model a backgrounded tab: the animation frame never arrives
  runReveals();
  assert.ok(toasts[0].classList.contains('toast--show'), 'the 50ms backstop must still reveal it');
});

// ---- admin.js: session expiry ---------------------------------------------

test('an expired session raises an error toast and the sign-out it accompanies does not navigate', async () => {
  setDom(adminDom);
  alertCalls.length = 0;

  const realNow = Date.now;
  const realError = console.error;
  const t0 = 1_800_000_000_000;
  let now = t0;
  Date.now = () => now;
  console.error = () => {};

  try {
    // Sign in: only the key probe succeeds, so loadAll() bails in its own catch
    // instead of dragging the whole render pass into this test.
    fetchImpl = async (url) => {
      if (url === '/api/admin/ping') return { ok: true };
      throw new Error('offline');
    };
    adminDom.querySelector('#adm-key').value = 'test-endpoint-key';
    const submits = adminDom.querySelector('#adm-login-form').handlers.submit || [];
    assert.equal(submits.length, 1, 'admin.js should have wired the login form');
    await captureToasts(() => { submits[0]({ preventDefault() {} }); });

    assert.equal(sessionStorage.getItem('adm_ts'), String(t0), 'sign-in should start the session clock');
    assert.equal(adminDom.querySelector('#adm-dash').classList.contains('hidden'), false);

    // Walk past the one-hour timeout, then make any authed request.
    now = t0 + 61 * 60 * 1000;
    const toasts = await captureToasts(() => { adminDom.querySelector('#adm-refresh').click(); });

    assertErrorToast(toasts, 'Session expired. Please sign in again.');
    // signOut() ran, and it swapped panels in place — no reload, no redirect — so
    // the non-blocking toast is still attached to a live document.
    assert.equal(adminDom.querySelector('#adm-dash').classList.contains('hidden'), true, 'the dashboard should be hidden');
    assert.equal(adminDom.querySelector('#adm-login').style.display, '', 'the login form should be shown again');
    assert.equal(adminDom.querySelector('#adm-key').value, '');
    assert.equal(sessionStorage.getItem('adm_ts'), null, 'the session clock should be cleared');
    assert.equal(toasts[0].parent, adminDom.getElementById('toast-host'));

    // The clock is cleared before the toast, so the eight sibling requests in the
    // same loadAll() burst re-enter checkSessionTimeout and no-op: still one toast.
    const more = await captureToasts(() => { adminDom.querySelector('#adm-refresh').click(); });
    assert.equal(more.length, 1, 'a signed-out dashboard must not keep re-toasting');
  } finally {
    Date.now = realNow;
    console.error = realError;
  }
});

// ---- tree walker -----------------------------------------------------------

function findByClass(node, cls) {
  if (!node) return null;
  if ((node.className || '').split(' ').includes(cls)) return node;
  for (const c of node.children || []) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}
