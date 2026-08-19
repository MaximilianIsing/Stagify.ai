// Tier: frontend island logic (DOM-stubbed) — public/scripts/admin.js, the admin
// dashboard SHELL (as distinct from the panels it mounts, which have their own suites).
//
// WHY THIS EXISTS. admin.js is one boot IIFE: importing it registers ~15 DOM
// listeners and defines the closures they call, but running the import alone
// executes almost none of that. The pre-existing suite (admin-toast.test.js) imports
// the module for its own purposes and never fires a handler, so 25 of admin.js's 46
// functions had never executed under test — including every branch of the sign-in
// flow, the whole `loadAll()` fan-out, and the hosted-image upload. That is the
// shell's entire behaviour, and it holds the access key.
//
// So this suite drives the module the way a browser would: it builds a DOM, imports
// admin.js so the IIFE binds to it, then dispatches real events at the elements the
// handlers were attached to.
//
// WHAT IS ACTUALLY WORTH PINNING here (the rest is coverage that follows for free):
//   - the key lives in a closure and is NEVER written to sessionStorage — only a
//     timestamp is. A regression that persisted the key would survive every other
//     test in the repo,
//   - every request carries the key in the HEADER, never in the URL (a key in a URL
//     leaks via access logs, proxy logs, history and Referer — the server guards are
//     header-only for the same reason, see lib/http/http-guards.js),
//   - a wrong key does NOT sign the operator in, and five of them trip the local
//     lockout. That lockout is a UX affordance, not a security control — the real
//     ceiling is RL_ENDPOINT_KEY on the server — but it should still work,
//   - sign-out wipes the key and the loaded data, so a shared machine keeps nothing,
//   - loadAll() tolerates a partial outage: each CSV feed has its own .catch, so one
//     failing log endpoint must not blank the whole dashboard.
//
// The DOM is the shared harness in test/helpers/admin-dom.js. This suite opts into
// class lookups (`byClass`) because admin.js wires its tab and filter buttons via
// querySelectorAll — the toast suite deliberately leaves that returning [].

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, makeEl } from '../../helpers/admin-dom.js';

// ---- DOM + globals, installed BEFORE importing admin.js --------------------
// The IIFE resolves every element at import time, so the document has to be live
// and stay the same object for the lifetime of the suite.

/** Build the tab / filter button sets admin.js looks up by class. */
const mkTagged = (cls, dataKey, dataVal) => {
  const n = makeEl('button');
  n.classList.add(cls);
  n.dataset[dataKey] = dataVal;
  return n;
};

const tabs = ['overview', 'emails', 'referrals'].map((t) => mkTagged('adm-tab', 'tab', t));
const filters = ['all', 'pro', 'free'].map((f) => mkTagged('adm-filter', 'filter', f));
const panels = ['overview', 'emails', 'referrals'].map((p) => {
  const n = makeEl('div');
  n.classList.add('adm-panel');
  n.id = `panel-${p}`;
  return n;
});

const dom = makeDom({ byClass: { 'adm-tab': tabs, 'adm-filter': filters, 'adm-panel': panels } });
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

/** @type {string[]} */
let confirmCalls = [];
let confirmAnswer = true;
globalThis.confirm = /** @type {any} */ ((msg) => { confirmCalls.push(String(msg)); return confirmAnswer; });
globalThis.alert = /** @type {any} */ (() => {});
globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => { fn(); return 1; });
// The tab handler scrolls the new panel to the top via `window.scrollTo`.
globalThis.window = /** @type {any} */ ({ scrollTo: () => {} });

const sessionStore = /** @type {Record<string, string>} */ ({});
globalThis.sessionStorage = /** @type {any} */ ({
  getItem: (k) => (k in sessionStore ? sessionStore[k] : null),
  setItem: (k, v) => { sessionStore[k] = String(v); },
  removeItem: (k) => { delete sessionStore[k]; },
});

// The console persists its SESSION TOKEN here so a reload does not ask for the key
// again. It must be installed before the import: admin.js reads it in a boot IIFE to
// resume a stored session. Left empty, that IIFE finds nothing and does nothing —
// which is the state every test below starts from.
const localStore = /** @type {Record<string, string>} */ ({});
globalThis.localStorage = /** @type {any} */ ({
  getItem: (k) => (k in localStore ? localStore[k] : null),
  setItem: (k, v) => { localStore[k] = String(v); },
  removeItem: (k) => { delete localStore[k]; },
});

// FormData is only used as an opaque multipart body; record what was appended so the
// upload test can prove the file (not JSON) was sent.
globalThis.FormData = /** @type {any} */ (class { constructor() { this.entries = []; } append(k, v) { this.entries.push([k, v]); } });
globalThis.URL = /** @type {any} */ (Object.assign(globalThis.URL ?? {}, {
  createObjectURL: () => 'blob:fake', revokeObjectURL: () => {},
}));

// ---- fetch recorder --------------------------------------------------------
/** @type {{url: string, opts: any}[]} */
let calls = [];
/** @type {(url: string, opts: any) => any} */
let handler = () => ({ ok: true, json: async () => ({}), text: async () => '' });
globalThis.fetch = /** @type {any} */ ((url, opts) => {
  calls.push({ url: String(url), opts: opts || {} });
  // A handler that throws models a NETWORK failure, which real fetch surfaces as a
  // rejected promise — not a synchronous throw. Getting this wrong would send the
  // error past `.catch()` and out of the submit handler entirely, so the offline
  // branch would look broken when it is fine.
  try {
    return Promise.resolve(handler(String(url), opts || {}));
  } catch (err) {
    return Promise.reject(err);
  }
});

const KEY = 'test-admin-key';
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const okText = (body) => ({ ok: true, status: 200, json: async () => ({}), text: async () => body });

/** Let the handlers' promise chains settle (no real timers are involved). */
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const SESSION_TOKEN = 'sess-' + 'f'.repeat(59);
const SESSION_EXP = 4_000_000_000_000;

/** The default happy-path server: every endpoint loadAll() touches answers. */
function serveAll(url) {
  if (url.startsWith('/api/admin/session')) return okJson({ token: SESSION_TOKEN, expiresAt: SESSION_EXP });
  if (url.startsWith('/api/admin/ping')) return okJson({ ok: true });
  if (url.startsWith('/authstore')) return okJson({ users: [{ id: 'u1', email: 'a@b.com', plan: 'pro' }] });
  if (url.startsWith('/enterprise-domains')) return okJson({ domains: [] });
  if (url.startsWith('/api/hosted-images')) return okJson({ images: [] });
  return okText('a,b\n1,2\n');
}

await import('../../../public/scripts/admin.js');

const $ = (id) => dom.querySelector(`#${id}`);

/** Drive the sign-in form to a signed-in state. */
async function signIn(key = KEY) {
  handler = serveAll;
  $('adm-key').value = key;
  $('adm-login-form').dispatch('submit', { preventDefault() {} });
  await settle();
}

// ===========================================================================
// Sign-in
// ===========================================================================

test('a correct key signs in, loads every dashboard feed, and reveals the dashboard', async () => {
  calls = [];
  await signIn();

  const urls = calls.map((c) => c.url);
  assert.ok(urls.includes('/api/admin/session'), 'the key is spent minting a session, which is also what validates it');
  assert.ok(!urls.includes('/api/admin/ping'), 'and no separate probe is needed on top of the mint');
  for (const feed of ['/authstore', '/promptlogs', '/chatlogs', '/bugreports', '/masklogs', '/contactlogs', '/email-open-logs', '/enterprise-domains', '/api/hosted-images', '/rejectionlogs']) {
    assert.ok(urls.includes(feed), `loadAll() must fetch ${feed}`);
  }
  assert.equal($('adm-dash').classList.contains('hidden'), false, 'dashboard revealed');
  assert.equal($('adm-login').style.display, 'none', 'login form hidden');
  assert.match($('adm-last-refresh').textContent, /^Updated /);
});

test('SECURITY: the access key travels in a header, is never put in a URL, and is spent exactly once', async () => {
  calls = [];
  await signIn();

  for (const c of calls) {
    assert.ok(!c.url.includes(KEY), `key leaked into the URL: ${c.url}`);
    assert.ok(!c.url.includes(SESSION_TOKEN), `session token leaked into the URL: ${c.url}`);
  }

  // The key buys a session and is then gone. Every later request carries the token
  // instead — which opens the dashboard's routes only, expires, and can be revoked,
  // none of which is true of the key. A regression that simply kept using the key
  // would still work, so nothing but this assertion would notice.
  const withKey = calls.filter((c) => c.opts.headers['X-Stagify-Endpoint-Key'] === KEY);
  assert.deepEqual(withKey.map((c) => c.url), ['/api/admin/session'],
    'the master key must reach exactly one endpoint: the one that exchanges it');

  for (const c of calls.filter((x) => x.url !== '/api/admin/session')) {
    assert.equal(c.opts.headers['X-Stagify-Admin-Session'], SESSION_TOKEN,
      `${c.url} must authenticate with the session token`);
  }
});

test('SECURITY: the key is never persisted — only the token it was exchanged for is', async () => {
  await signIn();

  // The whole point of the exchange. Persisting `endpoint_key` would put the master
  // secret — which also unlocks /api/stage-by-endpoint-key and POST /api/getpro, and
  // which can only be revoked by editing an env var and redeploying — into browser
  // storage indefinitely. What is stored instead is scoped, expiring and revocable.
  for (const [store, name] of [[sessionStore, 'sessionStorage'], [localStore, 'localStorage']]) {
    for (const [k, v] of Object.entries(store)) {
      assert.ok(!String(v).includes(KEY), `key persisted under ${name}["${k}"]`);
    }
  }
  assert.equal(localStore.adm_session, SESSION_TOKEN, 'the session token is what survives a reload');
  assert.equal(localStore.adm_session_exp, String(SESSION_EXP), 'with its expiry, so a lapsed session is known before a request goes out');
});

// ===========================================================================
// loadAll resilience
// ===========================================================================

test('one failing log feed does not blank the dashboard — the others still render', async () => {
  calls = [];
  handler = (url) => {
    if (url.startsWith('/promptlogs')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    return serveAll(url);
  };
  $('adm-refresh').dispatch('click');
  await settle();

  assert.ok(calls.some((c) => c.url === '/authstore'), 'the other feeds were still fetched');
  assert.match($('adm-last-refresh').textContent, /^Updated /, 'the render completed despite the failure');
});

test('a 404 on /rejectionlogs is the NORMAL state and must not blank the dashboard', () => {
  // Nothing writes rejection_logs.csv until something is actually refused, so a
  // fresh deploy 404s this feed forever and that is not an error. The cards
  // built on it are responsible for saying "none recorded" rather than drawing a
  // refusal rate of zero; what this pins is that the load still completes.
  calls = [];
  handler = (url) => {
    if (url.startsWith('/rejectionlogs')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return serveAll(url);
  };
  $('adm-refresh').dispatch('click');
  return settle().then(() => {
    assert.ok(calls.some((c) => c.url === '/rejectionlogs'), 'it is still requested');
    assert.ok(calls.some((c) => c.url === '/authstore'), 'the other feeds were still fetched');
    assert.match($('adm-last-refresh').textContent, /^Updated /, 'the render completed');
  });
});

// ===========================================================================
// Tabs, filters, search
// ===========================================================================

test('clicking a tab activates its panel and lazy-loads the referrals panel exactly once', async () => {
  calls = [];
  handler = serveAll;
  const referralsTab = tabs[2];
  $('adm-tabs').dispatch('click', { target: referralsTab });
  await settle();

  assert.ok(referralsTab.classList.contains('active'), 'the clicked tab is marked active');
  assert.equal(referralsTab.getAttribute('aria-selected'), 'true');
  assert.ok(dom.byId['panel-referrals'].classList.contains('active'), 'its panel is shown');
  assert.ok(calls.some((c) => c.url.includes('/api/admin/referrals')), 'the panel lazy-loaded on first open');

  const before = calls.length;
  $('adm-tabs').dispatch('click', { target: referralsTab });
  await settle();
  assert.equal(calls.length, before, 're-opening the tab must not refetch');
});

test('a click that misses a tab button is ignored', () => {
  const stray = makeEl('div'); // no .adm-tab class, so closest() returns null
  const activeBefore = tabs.map((t) => t.classList.contains('active'));
  $('adm-tabs').dispatch('click', { target: stray });
  assert.deepEqual(tabs.map((t) => t.classList.contains('active')), activeBefore, 'nothing changed');
});

test('a user filter marks itself active and deactivates its siblings', () => {
  filters[1].dispatch('click');
  assert.ok(filters[1].classList.contains('active'), 'the clicked filter is active');
  assert.equal(filters[0].classList.contains('active'), false, 'the previous one is not');
});

test('each search box re-renders its own table', () => {
  for (const id of ['adm-user-search', 'adm-bug-search', 'adm-contact-search', 'adm-email-open-search']) {
    const box = $(id);
    box.value = 'query';
    assert.doesNotThrow(() => box.dispatch('input'), `${id} handler threw`);
  }
});

// ===========================================================================
// Hosted-image upload
// ===========================================================================

test('picking a file enables the upload button and shows the filename', () => {
  const fileInput = $('adm-host-file');
  fileInput.files = [{ name: 'kitchen.png' }];
  fileInput.dispatch('change');

  assert.equal($('adm-host-fname').textContent, 'kitchen.png');
  assert.equal($('adm-host-upload-btn').disabled, false);
});

test('the pick button forwards the click to the hidden file input', () => {
  let clicked = 0;
  $('adm-host-file').addEventListener('click', () => { clicked += 1; });
  $('adm-host-pick').dispatch('click');
  assert.equal(clicked, 1);
});

test('a successful upload posts multipart (not JSON) and renders the public link', async () => {
  calls = [];
  handler = (url) => (url === '/api/host-image'
    ? okJson({ id: 'img_1', path: '/i/img_1', entry: { id: 'img_1', originalName: 'kitchen.png' } })
    : serveAll(url));

  $('adm-host-file').files = [{ name: 'kitchen.png' }];
  $('adm-host-file').dispatch('change');
  $('adm-host-upload-btn').dispatch('click');
  await settle();

  const post = calls.find((c) => c.url === '/api/host-image');
  assert.ok(post, 'the upload was sent');
  assert.equal(post.opts.method, 'POST');
  assert.equal(post.opts.headers['Content-Type'], undefined,
    'multipart bodies must NOT get an explicit Content-Type — the browser sets the boundary');
  assert.equal(post.opts.headers['X-Stagify-Admin-Session'], SESSION_TOKEN);
  assert.deepEqual(post.opts.body.entries.map(([k]) => k), ['image']);

  const box = $('adm-host-result');
  assert.equal(box.classList.contains('hidden'), false, 'the result box is revealed');
  assert.equal(box.classList.contains('adm-host-err'), false, 'and not in its error state');
});

test('a failed upload reports the server error and re-enables the button', async () => {
  handler = (url) => (url === '/api/host-image'
    ? { ok: false, status: 413, json: async () => ({ error: 'File too large' }), text: async () => '' }
    : serveAll(url));

  $('adm-host-file').files = [{ name: 'huge.png' }];
  $('adm-host-file').dispatch('change');
  $('adm-host-upload-btn').dispatch('click');
  await settle();

  assert.equal($('adm-host-result').textContent, 'Upload failed: File too large',
    'the server-supplied reason is surfaced verbatim');
  assert.ok($('adm-host-result').classList.contains('adm-host-err'));
  assert.equal($('adm-host-upload-btn').disabled, false, 'the operator can retry');
});

test('clicking upload with no file selected does nothing', async () => {
  // Note the failed-upload path deliberately KEEPS the selection so the operator can
  // retry, so the selection has to be cleared the way the file input would.
  $('adm-host-file').files = null;
  $('adm-host-file').dispatch('change');
  assert.equal($('adm-host-upload-btn').disabled, true, 'clearing the file disables the button');

  calls = [];
  $('adm-host-upload-btn').dispatch('click');
  await settle(2);
  assert.deepEqual(calls, [], 'no request without a file');
});

// ===========================================================================
// Uptime reset (a destructive, confirm-gated action)
// ===========================================================================

test('the uptime reset asks for confirmation first, and declining sends nothing', async () => {
  calls = [];
  confirmCalls = [];
  confirmAnswer = false;
  $('adm-reset-status').dispatch('click');
  await settle(2);

  assert.equal(confirmCalls.length, 1, 'the operator was asked');
  assert.match(confirmCalls[0], /cannot be undone/i, 'and told it is irreversible');
  assert.deepEqual(calls, [], 'declining must not reset anything');
});

test('confirming the uptime reset posts and reports success', async () => {
  calls = [];
  confirmAnswer = true;
  handler = () => okJson({ ok: true });
  $('adm-reset-status').dispatch('click');
  await settle();

  const post = calls.find((c) => c.url === '/api/status/reset');
  assert.ok(post, 'the reset was sent');
  assert.equal(post.opts.method, 'POST');
  assert.match($('adm-reset-status-msg').textContent, /reset/i);
});

test('a failed uptime reset surfaces the error and restores the button', async () => {
  confirmAnswer = true;
  handler = () => ({ ok: false, status: 500, json: async () => ({ error: 'nope' }), text: async () => '' });
  $('adm-reset-status').dispatch('click');
  await settle();

  assert.match($('adm-reset-status-msg').textContent, /Reset failed: nope/);
  assert.equal($('adm-reset-status').disabled, false);
});

// ===========================================================================
// Sign-out
// ===========================================================================

test('signing out revokes the session server-side, then wipes it locally', async () => {
  await signIn();
  assert.ok(localStore.adm_session, 'precondition: signed in');

  calls = [];
  $('adm-signout').dispatch('click');

  // Clearing storage alone would leave a live token on the server that any copy of
  // it could keep using, so sign-out has to say so out loud.
  const revoke = calls.find((c) => c.url === '/api/admin/session');
  assert.ok(revoke, 'sign-out must tell the server');
  assert.equal(revoke.opts.method, 'DELETE');
  assert.equal(revoke.opts.headers['X-Stagify-Admin-Session'], SESSION_TOKEN, 'and name the token it is revoking');

  assert.equal(localStore.adm_session, undefined, 'the stored token is cleared');
  assert.equal(localStore.adm_session_exp, undefined, 'and its expiry with it');
  assert.ok($('adm-dash').classList.contains('hidden'), 'the dashboard is hidden');
  assert.equal($('adm-login').style.display, '', 'the login form is restored');
  assert.equal($('adm-key').value, '', 'the key input is emptied');

  // The definitive check: a request made after sign-out carries no credential at all.
  calls = [];
  handler = serveAll;
  $('adm-refresh').dispatch('click');
  await settle();
  for (const c of calls) {
    assert.notEqual(c.opts.headers['X-Stagify-Endpoint-Key'], KEY, `${c.url} still carried the old key`);
    assert.notEqual(c.opts.headers['X-Stagify-Admin-Session'], SESSION_TOKEN, `${c.url} still carried the revoked token`);
  }
});

// ===========================================================================
// Sign-in failure paths — DELIBERATELY LAST
//
// `_loginAttempts` and `_lockoutUntil` are module-level closure state with no reset
// hook, and the lockout lasts 30s of real time. Run these earlier and every later
// sign-in silently takes the locked-out branch instead of authenticating — which
// does not fail loudly, it just makes those tests assert nothing. Ordering is the
// only lever available, so keep this block at the bottom of the file.
// ===========================================================================

test('a rejected key does not sign in, and surfaces the error inline', async () => {
  calls = [];
  handler = () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' });
  $('adm-key').value = 'wrong-key';
  $('adm-login-form').dispatch('submit', { preventDefault() {} });
  await settle();

  assert.equal($('adm-login-err').textContent, 'Invalid access key.');
  assert.equal($('adm-login-err').classList.contains('hidden'), false);
  assert.deepEqual(calls.map((c) => c.url), ['/api/admin/session'],
    'a failed sign-in must not touch a single data endpoint');
});

test('a network failure during sign-in is reported as a network error, not a bad key', async () => {
  handler = () => { throw new Error('offline'); };
  $('adm-key').value = 'some-key';
  $('adm-login-form').dispatch('submit', { preventDefault() {} });
  await settle();

  assert.equal($('adm-login-err').textContent, 'Network error. Please try again.',
    'an outage must not be reported to the operator as a wrong key');
  assert.equal($('adm-login-btn').disabled, false, 'the button is restored by the finally block');
});

test('five rejected keys trip the local lockout, and further attempts never reach the network', async () => {
  handler = () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' });
  // Only ONE attempt has been counted so far: the rejected-key test above. The
  // network-error test did not increment — admin.js counts a rejection from the
  // server, not an outage, which is the right call (an offline operator is not an
  // attacker). So four more reach the threshold of five.
  for (let i = 0; i < 4; i++) {
    $('adm-key').value = `wrong-${i}`;
    $('adm-login-form').dispatch('submit', { preventDefault() {} });
    await settle(3);
  }
  assert.match($('adm-login-err').textContent, /Locked for 30 seconds/);

  calls = [];
  $('adm-key').value = 'wrong-again';
  $('adm-login-form').dispatch('submit', { preventDefault() {} });
  await settle(2);
  assert.deepEqual(calls, [], 'while locked out, no request is made at all');
  assert.match($('adm-login-err').textContent, /Try again in \d+s/);
});

test('an empty key is rejected client-side without a request', async () => {
  calls = [];
  $('adm-key').value = '   ';
  $('adm-login-form').dispatch('submit', { preventDefault() {} });
  await settle(2);
  assert.deepEqual(calls, [], 'a blank key never reaches the server');
});
