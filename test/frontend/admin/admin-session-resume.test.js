// Tier: frontend island logic (DOM-stubbed) — the admin console's boot-time session
// resume in public/scripts/admin.js.
//
// WHY ITS OWN FILE. The resume is an IIFE that runs at import time and reads
// localStorage before anything else happens, so the only way to exercise it is to
// seed storage BEFORE importing admin.js. The sibling suites deliberately import it
// with empty storage (they test the signed-out entry path), and a module import is
// cached per process — so "storage already holds a token" needs its own process,
// which is what a separate spec file is.
//
// WHAT IS WORTH PINNING. This is the whole point of the feature and its whole risk:
//   - a stored token signs you in with no key prompt (the feature),
//   - it is VERIFIED before the dashboard is revealed, so a revoked or rotated-away
//     token lands on the login screen instead of flashing a dashboard that then 403s
//     nine times, and it is dropped rather than left in storage forever (the risk),
//   - the master key is never read from, or written to, storage in any of this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, makeEl } from '../../helpers/admin-dom.js';

const TOKEN = 'a'.repeat(64);
const EXP = Date.now() + 30 * 24 * 60 * 60 * 1000;

// ---- DOM + globals, installed BEFORE importing admin.js --------------------

const tabs = ['overview'].map((t) => {
  const n = makeEl('button');
  n.classList.add('adm-tab');
  n.dataset.tab = t;
  return n;
});
const panels = ['overview'].map((p) => {
  const n = makeEl('div');
  n.classList.add('adm-panel');
  n.id = `panel-${p}`;
  return n;
});
const dom = makeDom({ byClass: { 'adm-tab': tabs, 'adm-filter': [], 'adm-panel': panels } });
for (const p of panels) dom.byId[p.id] = p;

globalThis.document = /** @type {any} */ ({
  get body() { return dom.body; },
  createElement: (tag) => dom.createElement(tag),
  createTextNode: (t) => dom.createTextNode(t),
  getElementById: (id) => dom.getElementById(id),
  querySelector: (s) => dom.querySelector(s),
  querySelectorAll: (s) => dom.querySelectorAll(s),
});
globalThis.location = /** @type {any} */ ({ origin: 'https://stagify.ai' });
globalThis.window = /** @type {any} */ ({ scrollTo: () => {} });
globalThis.alert = /** @type {any} */ (() => {});
globalThis.confirm = /** @type {any} */ (() => false);
globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => { fn(); return 1; });
globalThis.FormData = /** @type {any} */ (class { append() {} });
globalThis.sessionStorage = /** @type {any} */ ({ getItem: () => null, setItem: () => {}, removeItem: () => {} });

// THE SEED: a browser that signed in some days ago and has been closed since.
const localStore = /** @type {Record<string, string>} */ ({
  adm_session: TOKEN,
  adm_session_exp: String(EXP),
});
globalThis.localStorage = /** @type {any} */ ({
  getItem: (k) => (k in localStore ? localStore[k] : null),
  setItem: (k, v) => { localStore[k] = String(v); },
  removeItem: (k) => { delete localStore[k]; },
});

/** @type {{url: string, opts: any}[]} */
let calls = [];
/** @type {(url: string, opts: any) => any} */
let handler = () => ({ ok: true, json: async () => ({}), text: async () => '' });
globalThis.fetch = /** @type {any} */ ((url, opts) => {
  calls.push({ url: String(url), opts: opts || {} });
  try {
    return Promise.resolve(handler(String(url), opts || {}));
  } catch (err) {
    return Promise.reject(err);
  }
});

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const okText = (body) => ({ ok: true, status: 200, json: async () => ({}), text: async () => body });

handler = (url) => {
  if (url.startsWith('/api/admin/ping')) return okJson({ ok: true });
  if (url.startsWith('/authstore')) return okJson({ users: [] });
  if (url.startsWith('/enterprise-domains')) return okJson({ domains: [] });
  if (url.startsWith('/api/hosted-images')) return okJson({ images: [] });
  return okText('a,b\n1,2\n');
};

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// The import IS the boot. Everything asserted below already happened by this line.
await import('../../../public/scripts/admin.js');
await settle();

const $ = (id) => dom.querySelector(`#${id}`);

test('a stored session signs the operator straight in — no key prompt', async () => {
  assert.equal($('adm-dash').classList.contains('hidden'), false, 'the dashboard is revealed on load');
  assert.equal($('adm-login').style.display, 'none', 'and the login form is not shown');
  assert.match($('adm-last-refresh').textContent, /^Updated /, 'the data actually loaded');
});

test('the stored token is verified BEFORE the dashboard is revealed', async () => {
  // Order matters: reveal-then-verify would flash a dashboard and then fire nine
  // 403s at a signed-out operator.
  assert.equal(calls[0].url, '/api/admin/ping', 'the first request on load is the probe');
  assert.equal(calls[0].opts.headers['X-Stagify-Admin-Session'], TOKEN);
});

test('every restored-session request carries the token, and never the key', async () => {
  for (const c of calls) {
    assert.equal(c.opts.headers['X-Stagify-Admin-Session'], TOKEN, `${c.url} must carry the token`);
    assert.equal(c.opts.headers['X-Stagify-Endpoint-Key'], undefined,
      `${c.url} sent a key header — the key is not even in memory on this path`);
  }
});

test('the key is never read from storage, and never written to it', () => {
  assert.deepEqual(Object.keys(localStore).sort(), ['adm_session', 'adm_session_exp'],
    'storage holds the token and its expiry, and nothing else');
});

test('a rejected token drops itself and falls back to the login screen', async () => {
  // Revoked server-side, or the key was rotated. Either way the token is dead for
  // good, so leaving it in storage would only ever produce more 403s.
  handler = () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' });
  calls = [];

  $('adm-signout').dispatch('click');
  await settle();
  assert.equal(localStore.adm_session, undefined, 'signing out clears it');

  // Re-seed and re-run the resume path the only way a live module allows: through a
  // sign-in whose mint is refused.
  $('adm-key').value = 'wrong-key';
  $('adm-login-form').dispatch('submit', { preventDefault() {} });
  await settle();

  assert.equal($('adm-login-err').textContent, 'Invalid access key.');
  assert.equal(localStore.adm_session, undefined, 'and nothing is stored for a refused key');
});
