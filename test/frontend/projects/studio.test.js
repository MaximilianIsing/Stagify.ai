// Tier: frontend island logic (DOM-stubbed) — the Listing Studio driven the way a
// browser drives it: public/scripts/projects-app.js mounted against a fake document,
// then its handlers dispatched at the elements they were attached to.
//
// WHY THIS EXISTS SEPARATELY FROM projects-app.test.js. That file covers the pure
// selectors and the access DECISION. This one covers the wiring, which is where an entry
// script's real behaviour lives and where nothing else can see it: ~40 handlers and
// closures that a bare import defines but never runs. The pattern is the one
// test/frontend/admin/admin-shell.test.js established for admin.js — build a document,
// mount, dispatch — because there is no jsdom here and the house style is a hand-rolled
// shim per surface (the element factory itself is the shared test/helpers/admin-dom.js).
//
// WHAT IS ACTUALLY WORTH PINNING, as opposed to coverage that follows for free:
//
//  1. THE ACCESS GATE'S THREE OUTCOMES. Anonymous and unknown users are REDIRECTED, not
//     shown the shell; a signed-in free user gets the upgrade dialog; only `pro` sets
//     `pj-ready`, which is the class that un-hides the page. Since the hidden state is
//     the CSS default, a bug that skipped `reveal()` would look like an outage — but a
//     bug that revealed too early is a leak, and only the class ordering distinguishes
//     them.
//  2. THE FOUR POLLING STOP CONDITIONS. A 2.5s timer that never stops is a real bug
//     class: it must stop on drain, on a hidden tab, on teardown, AND on the bounded
//     "nothing ever queued" case — which exists precisely because isProgressComplete
//     refuses to call an empty queue finished.
//  3. TEARDOWN DISCONNECTS THE OBSERVER AND REVOKES THE BLOBS. An IntersectionObserver
//     left connected pins every node it watched; an un-revoked object URL pins its bytes.
//  4. A REDRAW RETAINS, IT DOES NOT RELEASE. Every override and every poll tick redraws.
//     Releasing all the object URLs there would re-download the whole shoot each time.
//  5. THE HERO/ROOM OVERRIDES ACTUALLY PATCH. The tray is the operator's argument with
//     the auto-clustering; a control that renders but sends nothing is the worst outcome
//     because it looks like it worked.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEl } from '../../helpers/admin-dom.js';
import { promptMatrix } from '../../../lib/staging/promptMatrix.js';
import {
  FURNITURE_STYLES,
  OTHER_ROOM_TYPE,
  ROOM_TYPES,
} from '../../../public/scripts/projects/vocab.js';
import { SHARE_ELEMENT_IDS } from '../../../public/scripts/projects/share-panel.js';

// The REAL English pack, not a hand-written map. projects.html loads language-loader.js
// for exactly one reason — the unstageable rejection sentences live under
// `errors.unstageable.*` in all 11 packs — so stubbing the genuine file is what makes the
// tray's rejection copy an end-to-end pin rather than a restatement of the stub.
const englishPack = JSON.parse(
  readFileSync(new URL('../../../public/languages/english.json', import.meta.url), 'utf8')
);

// ── Global ownership ─────────────────────────────────────────────────────────
// This spec REPLACES a set of globals for the whole FILE rather than per test, and that
// is forced: the module under test boots on import and resolves its elements once, so the
// stub document must be live before the import and stay the same object afterwards. That
// is the same constraint test/frontend/admin/admin-shell.test.js works under.
//
// File-scoped teardown is still worth having. `node --test` isolates each spec file in its
// own process today, so nothing downstream can observe these — but that is a property of
// the runner's default isolation, not of this file, and a spec should not silently depend
// on it. A leaked DOM stub is the classic source of an unreproducible failure in an
// unrelated file, so the globals go back the way test/helpers/auth-modal-dom.js restores
// its own.
const saved = {
  clearTimeout: globalThis.clearTimeout,
  IntersectionObserver: globalThis.IntersectionObserver,
  XMLHttpRequest: globalThis.XMLHttpRequest,
  FormData: globalThis.FormData,
  fetch: globalThis.fetch,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  document: globalThis.document,
  window: globalThis.window,
  location: globalThis.location,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};

after(() => {
  globalThis.clearTimeout = saved.clearTimeout;
  globalThis.IntersectionObserver = saved.IntersectionObserver;
  globalThis.XMLHttpRequest = saved.XMLHttpRequest;
  globalThis.FormData = saved.FormData;
  globalThis.fetch = saved.fetch;
  globalThis.requestAnimationFrame = saved.requestAnimationFrame;
  globalThis.document = saved.document;
  globalThis.window = saved.window;
  globalThis.location = saved.location;
  URL.createObjectURL = saved.createObjectURL;
  URL.revokeObjectURL = saved.revokeObjectURL;
});

// ── Element stub ─────────────────────────────────────────────────────────────
// makeEl covers classList/dataset/attrs/handlers/appendChild. These are the few
// members the Listing Studio touches that it does not model.

/** @type {string[]} */
const focused = [];

/** @param {string} tag */
function stubEl(tag) {
  const node = /** @type {any} */ (makeEl(tag));

  // NOTE: the detach-on-`textContent` behaviour every redraw here relies on
  // (`root.textContent = ''`, `tray.textContent = ''`, `projectList.textContent = ''`)
  // now lives in the shared `makeEl` itself — it was modelled locally first, then moved
  // once the admin suites were confirmed green against it. Deliberately NOT duplicated
  // here: two copies of the same DOM model is how they drift, and the local copy would
  // silently mask a regression in the shared one.
  node.focus = () => focused.push(node.id || node.tagName);
  node.removeAttribute = (name) => {
    delete node.attrs[name];
    if (name === 'src') node.src = undefined;
  };
  node.checked = false;
  Object.defineProperty(node, 'parentElement', {
    get: () => node.parent,
    configurable: true,
  });
  return node;
}

/** Every node under `root` (inclusive) carrying `className`. */
function findAll(root, className) {
  /** @type {any[]} */
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.classList && node.classList.contains(className)) out.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}

/** The first node under `root` carrying `className`, asserted to exist. */
function find(root, className) {
  const [first] = findAll(root, className);
  assert.ok(first, `no .${className} was rendered`);
  return first;
}

/** Concatenated textContent of every node under `root`. */
function textOf(node) {
  let out = node && node.textContent ? String(node.textContent) : '';
  for (const child of node.children || []) out += ` ${textOf(child)}`;
  return out;
}

// ── The ids projects.html ships ──────────────────────────────────────────────

const PAGE_IDS = [
  'pj-root', 'pj-checking', 'pj-gate', 'pj-title', 'pj-address', 'pj-create',
  'pj-project-list', 'pj-open-title', 'pj-open-address', 'pj-open-status', 'pj-delete',
  'pj-style', 'pj-remove-furniture', 'pj-variations', 'pj-stage', 'pj-progress',
  'pj-progress-bar', 'pj-progress-text', 'pj-confirm', 'pj-confirm-title',
  'pj-confirm-body', 'pj-confirm-yes', 'pj-confirm-no', 'pj-grid', 'pj-dropzone',
  'pj-file-input', 'pj-upload-progress', 'pj-upload-bar', 'pj-tray', 'pj-tray-status',
  'toast-host',
  'pj-extra', 'pj-cancel', 'pj-download-all', 'pj-progress-live', 'pj-blocked',
  'pj-dropzone-hint', 'pj-bulk',
];

/** @type {Record<string, any>} */
let els = {};
/** @type {Record<string, Function[]>} */
let documentListeners = {};
/** @type {Record<string, Function[]>} */
let windowListeners = {};
let visibility = 'visible';

// ── Timers: window.setTimeout is faked so polling is deterministic ───────────
// Only the studio's own timers land in `scheduled` (their ids start at 1000), so the
// clearTimeout wrapper can forward everything else — toast.js's real timers included —
// to the genuine implementation.

/** @type {Array<{ id: number, ms: number, fn: Function }>} */
const scheduled = [];
let nextTimerId = 1000;
const realClearTimeout = saved.clearTimeout;
globalThis.clearTimeout = /** @type {any} */ ((id) => {
  const index = scheduled.findIndex((timer) => timer.id === id);
  if (index !== -1) scheduled.splice(index, 1);
  else realClearTimeout(/** @type {any} */ (id));
});

// ── Observers, object URLs, redirects ────────────────────────────────────────

/** @type {any[]} */
const observers = [];
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    /** @type {any[]} */
    this.observed = [];
    this.disconnected = false;
    observers.push(this);
  }

  observe(node) {
    this.observed.push(node);
  }

  unobserve(node) {
    this.observed = this.observed.filter((other) => other !== node);
  }

  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }

  /** Report `node` as scrolled into view, the way the browser would. */
  enter(node) {
    this.callback([{ isIntersecting: true, target: node }]);
  }
}
globalThis.IntersectionObserver = /** @type {any} */ (FakeIntersectionObserver);

let blobSeq = 0;
/** @type {string[]} */
const revoked = [];
URL.createObjectURL = /** @type {any} */ (() => `blob:stub-${(blobSeq += 1)}`);
URL.revokeObjectURL = /** @type {any} */ ((url) => revoked.push(String(url)));

/** @type {string[]} */
const redirects = [];

// ── Network ──────────────────────────────────────────────────────────────────

/** @type {Array<{ method: string, path: string, body: any }>} */
const requests = [];
/** @type {{ status: number, payload: any }|null} */
let failNext = null;

let projectsFixture = [
  { id: 'p1', title: 'Rosedale', address: '14 Rosedale Ave', status: 'staging' },
  { id: 'p2', title: 'Bathurst', address: '9 Bathurst St', status: 'ready' },
];

/** The listing GET /api/projects/:id hands back. Deliberately rich: a hero, an
 *  unstageable frame, a failed render, two variations, a room with renders but NO
 *  bible, and an unassigned photo. */
let detailFixture = {
  project: { id: 'p1', title: 'Rosedale', address: '14 Rosedale Ave', status: 'staging' },
  photos: [
    { id: 'ph1', projectId: 'p1', seq: 1, roomKey: 'living', roomType: 'living room', frameRole: 'hero', stageable: 1 },
    { id: 'ph2', projectId: 'p1', seq: 2, roomKey: 'living', stageable: 1 },
    // A REAL rejection code. `TOO_BLURRY` was invented by this fixture and the upload gate
    // has never emitted it (the taxonomy is PERSON_PORTRAIT/ANIMAL/FOOD/DOCUMENT/VEHICLE/
    // UNRELATED_OBJECT/UNSTAGEABLE — see lib/staging/unstageable.js), so with the tray now
    // showing the pack's SENTENCE for the category rather than the raw token, a made-up code
    // could only ever exercise the fallback and the two branches were indistinguishable.
    { id: 'ph3', projectId: 'p1', seq: 3, roomKey: 'kitchen', stageable: 0, unstageableCode: 'PERSON_PORTRAIT' },
    { id: 'ph4', projectId: 'p1', seq: 4, stageable: 1 },
  ],
  // SCORES ARE 0..100. The column is `quality_score INTEGER` (lib/data/projects.js) and the
  // judges emit `SCORE: <0-100>`; this fixture carried 0..1 fractions, which is the same
  // misreading that had the grid printing "Quality 0.91" with no scale on it. With the
  // fractions in place `Math.round` collapsed 0.91 and 0.7 to the same "1 / 100".
  renders: [
    { id: 'r1', photoId: 'ph1', variation: 1, status: 'ok', qualityScore: 91, consistencyScore: 84 },
    { id: 'r2', photoId: 'ph1', variation: 2, status: 'ok', qualityScore: 70, consistencyScore: null },
    { id: 'r3', photoId: 'ph2', variation: 1, status: 'failed', errorCode: 'TIMEOUT' },
    { id: 'r4', photoId: 'ph3', variation: 1, status: 'ok', qualityScore: 50, consistencyScore: 50 },
  ],
  bibles: [
    {
      id: 'b1',
      roomKey: 'living',
      version: 2,
      roomType: 'living room',
      furnitureStyle: 'coastal',
      doc: {
        // The REAL server shape: palette and lighting are slot->value maps, not strings.
        // This fixture said `palette: 'warm neutrals'` while the frontend typedef claimed
        // `string`, so the panel rendered "[object Object]" in production and the test
        // still passed. The fixture now mirrors what `normalizeBible` actually emits.
        palette: { walls: 'warm neutrals', primary: 'sand linen' },
        lighting: { direction: 'north light', temperature: 'cool 5200K' },
        pieces: [
          { slot: 'sofa', identity: 'low linen sofa', placement: 'facing the window', critical: true },
          { slot: 'rug', identity: 'jute rug' },
          {},
        ],
        negatives: ['no chandeliers', 'no plants'],
      },
    },
  ],
  progress: { queued: 2, running: 1, ok: 3, failed: 0, superseded: 0, total: 6 },
};

let progressFixture = { queued: 2, running: 1, ok: 3, failed: 0, superseded: 0, total: 6 };
let statusFixture = 'staging';

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

globalThis.fetch = /** @type {any} */ (
  async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url);
    requests.push({
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    if (failNext) {
      const failure = failNext;
      failNext = null;
      return { ok: false, status: failure.status, json: async () => failure.payload };
    }
    if (path.endsWith('/image')) return { ok: true, status: 200, blob: async () => ({ size: 4 }) };
    if (path.startsWith('/api/projects?')) return jsonResponse({ projects: projectsFixture });
    if (path.endsWith('/progress')) {
      return jsonResponse({ progress: progressFixture, status: statusFixture });
    }
    if (path.endsWith('/bible/regenerate')) {
      return jsonResponse({ ok: true, superseded: 2, queued: 2 });
    }
    if (path.endsWith('/stage')) return jsonResponse({ ok: true, queued: 6 });
    if (path === '/api/projects' && method === 'POST') {
      return jsonResponse({ project: { id: 'p9', title: 'Fresh', address: '' } });
    }
    if (/\/photos\/[^/]+$/.test(path)) return jsonResponse({ ok: true, photo: { id: 'ph1' } });
    if (/^\/api\/projects\/[^/?]+$/.test(path)) {
      if (method === 'DELETE') return jsonResponse({ ok: true, deleted: 1 });
      return jsonResponse(detailFixture);
    }
    return jsonResponse({});
  }
);

/** A fake XMLHttpRequest for the multipart upload. */
class FakeXhr {
  constructor() {
    /** @type {Record<string, string>} */
    this.headers = {};
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    /** @type {Record<string, Function[]>} */
    const uploadListeners = {};
    this.upload = {
      addEventListener: (type, fn) => {
        (uploadListeners[type] = uploadListeners[type] || []).push(fn);
      },
      fire: (type, event) => {
        for (const fn of uploadListeners[type] || []) fn(event);
      },
    };
    this.status = 200;
    this.responseText = JSON.stringify({ photos: [{ id: 'ph5' }], duplicates: [] });
    FakeXhr.last = this;
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers[name] = value;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  send(body) {
    this.body = body;
  }

  fire(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
}
/** @type {any} */
FakeXhr.last = null;
globalThis.XMLHttpRequest = /** @type {any} */ (FakeXhr);
globalThis.FormData = /** @type {any} */ (
  class {
    constructor() {
      /** @type {Array<[string, any, string|undefined]>} */
      this.entries = [];
    }

    append(name, value, filename) {
      this.entries.push([name, value, filename]);
    }
  }
);

// ── document / window ────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => {
  fn();
  return 1;
});

globalThis.document = /** @type {any} */ ({
  documentElement: stubEl('html'),
  body: stubEl('body'),
  get visibilityState() {
    return visibility;
  },
  getElementById: (id) => els[id] || null,
  createElement: (tag) => stubEl(tag),
  addEventListener: (type, fn) => {
    (documentListeners[type] = documentListeners[type] || []).push(fn);
  },
});

const fakeLocation = { pathname: '/projects.html', hash: '', replace: (url) => redirects.push(String(url)) };
globalThis.location = /** @type {any} */ (fakeLocation);
globalThis.window = /** @type {any} */ ({
  StagifyAuth: null,
  location: fakeLocation,
  // Mirrors language-loader.js's getText: the fallback is returned verbatim on a miss,
  // which is the branch the generic rejection sentence depends on.
  LanguageSystem: {
    getText: (key, fallback) => {
      let current = /** @type {any} */ (englishPack);
      for (const part of String(key).split('.')) {
        if (!current || typeof current !== 'object' || !(part in current)) return fallback;
        current = current[part];
      }
      return current === undefined ? fallback : current;
    },
  },
  addEventListener: (type, fn) => {
    (windowListeners[type] = windowListeners[type] || []).push(fn);
  },
  setTimeout: (fn, ms) => {
    const id = (nextTimerId += 1);
    scheduled.push({ id, ms, fn });
    return id;
  },
});

// Local aliases. This spec is linted with NODE globals (test/** is backend-scoped in
// eslint.config.js), so bare `document` / `window` are undefined identifiers here even
// though the module under test reads them off globalThis.
const doc = /** @type {any} */ (globalThis).document;
const win = /** @type {any} */ (globalThis).window;

// ── Harness helpers ──────────────────────────────────────────────────────────

/** Let every queued microtask and resolved fetch settle. */
async function flush() {
  for (let i = 0; i < 14; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A fresh page, so a re-mount cannot inherit the previous mount's handlers. */
function resetDom() {
  els = {};
  for (const id of PAGE_IDS) {
    const node = stubEl(id === 'pj-file-input' ? 'input' : 'div');
    node.id = id;
    els[id] = node;
  }
  els['pj-upload-bar'].parent = els['pj-upload-progress'];
  els['pj-upload-progress'].classList.add('hidden');
  els['pj-progress'].classList.add('hidden');
  els['pj-style'].value = 'modern';
  els['pj-variations'].value = '1';
  documentListeners = {};
  windowListeners = {};
  scheduled.length = 0;
  observers.length = 0;
  requests.length = 0;
  redirects.length = 0;
  revoked.length = 0;
  focused.length = 0;
  visibility = 'visible';
  doc.documentElement.classList.remove('pj-ready');
}

/**
 * Mount the page for a given signed-in user.
 * @param {{ plan?: string }|null} user - null → /me resolved to no user.
 * @param {{ authMissing?: boolean, authThrows?: boolean }} [opts]
 */
async function mount(user, opts = {}) {
  resetDom();
  if (opts.authMissing) win.StagifyAuth = null;
  else if (opts.authThrows) {
    win.StagifyAuth = { fetchMe: async () => { throw new Error('offline'); } };
  } else win.StagifyAuth = { fetchMe: async () => user };
  app.initProjectsPage();
  await flush();
}

/** Mount as a Stagify+ operator and open the fixture listing. */
async function mountOpen() {
  await mount({ plan: 'pro' });
  const [first] = findAll(els['pj-project-list'], 'pj-picker__btn');
  assert.ok(first, 'the picker must render a listing to open');
  first.dispatch('click');
  await flush();
}

const pollScheduled = () => scheduled.some((timer) => timer.ms === app.POLL_INTERVAL_MS);

/** Fire the pending poll timer. */
async function firePoll() {
  const index = scheduled.findIndex((timer) => timer.ms === app.POLL_INTERVAL_MS);
  assert.notEqual(index, -1, 'expected a scheduled poll');
  const [timer] = scheduled.splice(index, 1);
  timer.fn();
  await flush();
}

const fakeFile = (name = 'a.jpg', type = 'image/jpeg', size = 2048) => ({ name, type, size });

const sent = (method, pattern) =>
  requests.some((request) => request.method === method && pattern.test(request.path));

// The boot runs on import, with no StagifyAuth installed — the "auth.js failed to load"
// branch. Nothing else is wired, which is what the first test asserts.
resetDom();
const app = await import('../../../public/scripts/projects-app.js');

// ── The access gate ──────────────────────────────────────────────────────────

test('a missing StagifyAuth redirects immediately rather than waiting', async () => {
  // auth.js is a module script earlier in document order; if the global is absent it
  // failed to load, and waiting cannot help.
  await flush();
  assert.deepEqual(redirects, ['stagify-plus.html']);
  assert.ok(!doc.documentElement.classList.contains('pj-ready'), 'nothing was revealed');
});

test('a token that /me rejects is a redirect, not an upgrade prompt', async () => {
  await mount(null);
  assert.deepEqual(redirects, ['stagify-plus.html']);
  assert.ok(!els['pj-gate'].classList.contains('is-open'), 'the shell stays hidden');
});

test('a /me that throws is treated as no user', async () => {
  await mount(null, { authThrows: true });
  assert.deepEqual(redirects, ['stagify-plus.html']);
});

test('a signed-in free user sees the page revealed behind the upgrade dialog', async () => {
  await mount({ plan: 'free' });
  assert.deepEqual(redirects, [], 'they are signed in — do not throw them out');
  assert.ok(doc.documentElement.classList.contains('pj-ready'));
  assert.ok(els['pj-checking'].classList.contains('hidden'));
  assert.ok(els['pj-gate'].classList.contains('is-open'));
  assert.equal(els['pj-gate'].getAttribute('aria-hidden'), 'false');
  assert.ok(!sent('GET', /^\/api\/projects\?/), 'and no listing data is fetched for them');
});

test('a Stagify+ operator gets the page revealed and their listings loaded', async () => {
  await mount({ plan: 'pro' });
  assert.deepEqual(redirects, []);
  assert.ok(doc.documentElement.classList.contains('pj-ready'));
  assert.ok(!els['pj-gate'].classList.contains('is-open'));
  assert.ok(sent('GET', /^\/api\/projects\?limit=50$/));
});

test('the stall-out timer redirects only while the page is still hidden', async () => {
  await mount({ plan: 'pro' });
  const stall = scheduled.find((timer) => timer.ms === 9000);
  // The pro path clears it, so a *successful* check leaves nothing armed.
  assert.equal(stall, undefined, 'a completed check disarms the safety net');

  // The unresolved case: a /me that never settles leaves the timer armed, and firing it
  // bounces the operator rather than stranding them on a blank page.
  resetDom();
  win.StagifyAuth = { fetchMe: () => new Promise(() => {}) };
  app.initProjectsPage();
  await flush();
  const armed = scheduled.find((timer) => timer.ms === 9000);
  assert.ok(armed, 'a hung check must leave the safety net armed');
  armed.fn();
  assert.deepEqual(redirects, ['stagify-plus.html']);
});

// ── The listing picker ───────────────────────────────────────────────────────

test('the picker lists every listing and marks the open one', async () => {
  await mountOpen();
  const buttons = findAll(els['pj-project-list'], 'pj-picker__btn');
  assert.equal(buttons.length, 2);
  // The row is no longer one text node: it carries a title plus a meta line (date, photo
  // count, real status), because 20 near-identical rows were unusable for a photographer.
  assert.equal(find(buttons[0], 'pj-picker__title').textContent, 'Rosedale — 14 Rosedale Ave');
  assert.ok(buttons[0].classList.contains('is-current'), 'the open listing is marked');
  assert.equal(buttons[0].getAttribute('aria-current'), 'true');
  assert.ok(!buttons[1].classList.contains('is-current'));
});

test('an empty account gets an explicit empty state, not a blank list', async () => {
  const previous = projectsFixture;
  projectsFixture = [];
  try {
    await mount({ plan: 'pro' });
    assert.equal(find(els['pj-project-list'], 'pj-picker__empty').textContent, 'No listings yet.');
  } finally {
    projectsFixture = previous;
  }
});

test('a failed listing load reports rather than blanking the page', async () => {
  resetDom();
  win.StagifyAuth = { fetchMe: async () => ({ plan: 'pro' }) };
  failNext = { status: 500, payload: {} };
  app.initProjectsPage();
  await flush();
  assert.ok(doc.documentElement.classList.contains('pj-ready'), 'the shell still opens');
});

test('opening a listing fills the header, the tray and the grid', async () => {
  await mountOpen();
  assert.equal(els['pj-open-title'].textContent, 'Rosedale — 14 Rosedale Ave');
  assert.equal(els['pj-open-address'].textContent, '14 Rosedale Ave');
  assert.equal(els['pj-open-status'].textContent, 'staging');
  assert.ok(els['pj-root'].classList.contains('has-project'));
  assert.equal(els['pj-delete'].disabled, false);
  assert.equal(els['pj-stage'].disabled, false);
  assert.equal(findAll(els['pj-tray'], 'pj-thumb').length, 4);
  assert.equal(findAll(els['pj-grid'], 'pj-room').length, 3, 'living, kitchen, unassigned');
});

test('with nothing open the header says so and the actions are disabled', async () => {
  await mount({ plan: 'pro' });
  assert.equal(els['pj-open-title'].textContent, 'No listing open');
  assert.equal(els['pj-stage'].disabled, true);
  assert.equal(els['pj-delete'].disabled, true);
  assert.ok(!els['pj-root'].classList.contains('has-project'));
  assert.equal(find(els['pj-grid'], 'pj-empty').textContent, 'Nothing staged yet. Upload photos, then stage the listing.');
});

// ── Creating a listing ───────────────────────────────────────────────────────

test('creating without a title asks for one instead of POSTing', async () => {
  await mount({ plan: 'pro' });
  els['pj-title'].value = '   ';
  requests.length = 0;
  els['pj-create'].dispatch('click');
  await flush();
  assert.ok(!sent('POST', /^\/api\/projects$/));
  assert.ok(focused.includes('pj-title'), 'and puts the cursor where the fix is');
});

test('creating POSTs, clears the form and opens the new listing', async () => {
  await mount({ plan: 'pro' });
  els['pj-title'].value = 'Fresh';
  els['pj-address'].value = '1 New Rd';
  requests.length = 0;
  els['pj-create'].dispatch('click');
  await flush();
  const post = requests.find((request) => request.method === 'POST' && request.path === '/api/projects');
  assert.ok(post, 'the listing was created');
  assert.deepEqual(post.body, { title: 'Fresh', address: '1 New Rd' });
  assert.equal(els['pj-title'].value, '', 'the form is cleared');
  assert.ok(sent('GET', /^\/api\/projects\/p9$/), 'and the new listing is opened');
  assert.equal(els['pj-create'].disabled, false, 're-enabled for the next one');
});

test('a failed create re-enables the button', async () => {
  await mount({ plan: 'pro' });
  els['pj-title'].value = 'Nope';
  failNext = { status: 429, payload: {} };
  els['pj-create'].dispatch('click');
  await flush();
  assert.equal(els['pj-create'].disabled, false, 'never leave the operator stuck');
});

// ── Stage controls ───────────────────────────────────────────────────────────

test('staging sends the three options, with the variation count clamped', async () => {
  await mountOpen();
  els['pj-style'].value = 'coastal';
  els['pj-variations'].value = '9';
  els['pj-remove-furniture'].checked = true;
  requests.length = 0;
  els['pj-stage'].dispatch('click');
  await flush();
  // Staging is behind a pre-flight confirm now. ~90 renders and up to two hours used to
  // start on one unconfirmed click, on a page that already confirmed deleting ONE photo.
  assert.ok(!requests.some((r) => r.path.endsWith('/stage')), 'nothing is sent before the operator confirms');
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  const post = requests.find((request) => request.path.endsWith('/stage'));
  assert.ok(post);
  assert.deepEqual(post.body, {
    furnitureStyle: 'coastal',
    removeFurniture: true,
    variationCount: 3,
    additionalPrompt: '',
  });
});

test('a non-numeric variation count falls back to one rather than NaN', async () => {
  await mountOpen();
  els['pj-variations'].value = 'many';
  requests.length = 0;
  els['pj-stage'].dispatch('click');
  await flush();
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  const post = requests.find((request) => request.path.endsWith('/stage'));
  assert.equal(post.body.variationCount, 1);
});

test('staging with nothing open sends nothing', async () => {
  await mount({ plan: 'pro' });
  requests.length = 0;
  els['pj-stage'].dispatch('click');
  await flush();
  assert.ok(!sent('POST', /\/stage$/));
});

test('a failed stage leaves the button reflecting the real state, not disabled', async () => {
  await mountOpen();
  failNext = { status: 409, payload: { error: 'already staging' } };
  els['pj-stage'].dispatch('click');
  await flush();
  // Confirming is what actually sends it. Without this the primed `failNext` is never
  // consumed and leaks into the NEXT test's mount, where it fails that test's project
  // fetch and empties the picker — which is exactly how this manifested.
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  assert.equal(els['pj-stage'].disabled, false, 'a listing with photos is still stageable');
});

// ── The confirm dialog ───────────────────────────────────────────────────────

test('a destructive action opens the dialog with its own copy and takes focus', async () => {
  await mountOpen();
  els['pj-delete'].dispatch('click');
  assert.ok(els['pj-confirm'].classList.contains('is-open'));
  assert.equal(els['pj-confirm'].getAttribute('aria-hidden'), 'false');
  assert.equal(els['pj-confirm-title'].textContent, 'Delete this listing?');
  assert.match(els['pj-confirm-body'].textContent, /cannot be undone/);
  assert.equal(els['pj-confirm-yes'].textContent, 'Delete');
  assert.ok(focused.includes('pj-confirm-yes'));
});

test('cancelling closes the dialog and runs nothing', async () => {
  await mountOpen();
  els['pj-delete'].dispatch('click');
  requests.length = 0;
  els['pj-confirm-no'].dispatch('click');
  await flush();
  assert.ok(!els['pj-confirm'].classList.contains('is-open'));
  assert.ok(!sent('DELETE', /^\/api\/projects\/p1$/));
});

test('Escape closes the dialog; another key does not', async () => {
  await mountOpen();
  els['pj-delete'].dispatch('click');
  els['pj-confirm'].dispatch('keydown', { key: 'a' });
  assert.ok(els['pj-confirm'].classList.contains('is-open'), 'only Escape closes it');
  els['pj-confirm'].dispatch('keydown', { key: 'Escape' });
  assert.ok(!els['pj-confirm'].classList.contains('is-open'));
});

test('confirming after a cancel does nothing — the pending action is cleared', async () => {
  await mountOpen();
  els['pj-delete'].dispatch('click');
  els['pj-confirm-no'].dispatch('click');
  requests.length = 0;
  assert.doesNotThrow(() => els['pj-confirm-yes'].dispatch('click'));
  await flush();
  assert.ok(!sent('DELETE', /^\/api\/projects\/p1$/), 'a stale confirm must not fire');
});

test('confirming a delete removes the listing and reloads the picker', async () => {
  await mountOpen();
  els['pj-delete'].dispatch('click');
  requests.length = 0;
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  assert.ok(sent('DELETE', /^\/api\/projects\/p1$/));
  assert.ok(sent('GET', /^\/api\/projects\?limit=50$/), 'the picker is refreshed');
  assert.equal(els['pj-open-title'].textContent, 'No listing open', 'and nothing is left open');
  assert.equal(pollScheduled(), false, 'a delete stops the poller');
});

test('a failed delete keeps the listing open', async () => {
  await mountOpen();
  els['pj-delete'].dispatch('click');
  failNext = { status: 500, payload: {} };
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  assert.equal(els['pj-open-title'].textContent, 'Rosedale — 14 Rosedale Ave');
});

// ── Polling lifecycle ────────────────────────────────────────────────────────

test('opening a listing that is staging starts the poller', async () => {
  await mountOpen();
  assert.equal(pollScheduled(), true);
});

test('opening a listing that is not staging does not', async () => {
  const previous = detailFixture.project.status;
  detailFixture.project.status = 'ready';
  try {
    await mountOpen();
    assert.equal(pollScheduled(), false);
  } finally {
    detailFixture.project.status = previous;
  }
});

test('OPENING a mid-run listing announces nothing; only a TRANSITION speaks', async () => {
  // The announcement is a DIFF against the previous progress, so opening a listing has to
  // establish the baseline SILENTLY. Without that seed the baseline is null, every counter
  // reads as a change, and a screen-reader user who opens a half-finished listing is read
  // the entire queue before they have done anything.
  //
  // This was written after extracting the poller (projects/polling.js): mutating `seed()`
  // to a no-op left the whole suite green, which is exactly the silence worth failing on.
  await mountOpen();
  assert.equal(els['pj-progress-live'].textContent, '',
    'opening a listing must not announce the progress it merely found');

  // …and the very next poll, with the counters UNCHANGED, still says nothing.
  await firePoll();
  assert.equal(els['pj-progress-live'].textContent, '',
    'an unchanged poll is not a transition');

  // A real change does speak.
  progressFixture = { queued: 0, running: 1, ok: 5, failed: 0, superseded: 0, total: 6 };
  await firePoll();
  assert.notEqual(els['pj-progress-live'].textContent, '',
    'a frame finishing is the transition the live region exists for');
});

test('a poll updates the counters and reschedules while work remains', async () => {
  await mountOpen();
  progressFixture = { queued: 1, running: 2, ok: 3, failed: 0, superseded: 0, total: 6 };
  await firePoll();
  assert.equal(els['pj-progress-bar'].style.width, '50%');
  assert.match(els['pj-progress-text'].textContent, /3 done · 2 running · 1 queued · 0 failed/);
  assert.equal(els['pj-progress'].classList.contains('hidden'), false);
  assert.equal(pollScheduled(), true, 'still work to do');
});

test('STOP CONDITION 1: a drained queue stops the poller and re-reads the listing', async () => {
  // Note what the fixtures do here: /progress reports a drained queue while GET /:id
  // still says `status: 'staging'` with pending counters. That disagreement is the real
  // shape of the bug this pins — the completing tick refreshes, the refresh re-arms off
  // the stale status, the next tick completes again, and the page re-reads the listing
  // every 2.5s for the life of the tab. The tick that observed the drain is the
  // authority, so it stops the poller AFTER the refresh.
  await mountOpen();
  progressFixture = { queued: 0, running: 0, ok: 6, failed: 0, superseded: 0, total: 6 };
  requests.length = 0;
  await firePoll();
  assert.equal(pollScheduled(), false, 'the poller must stop');
  assert.ok(sent('GET', /^\/api\/projects\/p1$/), 'and pull the finished renders');
});

test('opening a listing whose status lags its drained queue does not start polling', async () => {
  // The other half of the same fix, pinned separately so neither can be removed on its
  // own: `status === 'staging'` is not sufficient grounds to watch a run. The counters
  // are.
  const previousProgress = detailFixture.progress;
  detailFixture.progress = { queued: 0, running: 0, ok: 6, failed: 0, superseded: 0, total: 6 };
  try {
    await mountOpen();
    assert.equal(detailFixture.project.status, 'staging', 'the status still says staging');
    assert.equal(pollScheduled(), false, 'but there is nothing left to watch');
  } finally {
    detailFixture.progress = previousProgress;
  }
});

test('a hidden/visible cycle does not resume a run whose queue already drained', async () => {
  const previousProgress = detailFixture.progress;
  detailFixture.progress = { queued: 0, running: 0, ok: 6, failed: 0, superseded: 0, total: 6 };
  try {
    await mountOpen();
    visibility = 'visible';
    for (const fn of documentListeners.visibilitychange) fn();
    assert.equal(pollScheduled(), false);
  } finally {
    detailFixture.progress = previousProgress;
  }
});

test('STOP CONDITION 2: a hidden tab stops the poller, and returning resumes it', async () => {
  await mountOpen();
  assert.ok(documentListeners.visibilitychange, 'the entry must listen for it');
  visibility = 'hidden';
  for (const fn of documentListeners.visibilitychange) fn();
  assert.equal(pollScheduled(), false, 'a backgrounded tab shows nobody anything');
  visibility = 'visible';
  for (const fn of documentListeners.visibilitychange) fn();
  assert.equal(pollScheduled(), true, 'and it picks back up');
});

test('returning to a tab whose listing is no longer staging does not resume', async () => {
  const previous = detailFixture.project.status;
  detailFixture.project.status = 'ready';
  try {
    await mountOpen();
    visibility = 'visible';
    for (const fn of documentListeners.visibilitychange) fn();
    assert.equal(pollScheduled(), false);
  } finally {
    detailFixture.project.status = previous;
  }
});

test('STOP CONDITION 3: teardown stops the poller, disconnects the observers and revokes', async () => {
  await mountOpen();
  const shot = find(els['pj-grid'], 'pj-shot');
  const gridObserver = observers.find((observer) => observer.observed.includes(shot));
  assert.ok(gridObserver, 'the grid lazy-loads through an observer');
  gridObserver.enter(shot);
  await flush();
  assert.match(String(shot.src), /^blob:stub-/, 'the bytes arrived as an object URL');

  revoked.length = 0;
  assert.ok(windowListeners.pagehide, 'teardown must be wired to pagehide');
  for (const fn of windowListeners.pagehide) fn();

  assert.equal(pollScheduled(), false);
  for (const observer of observers) {
    assert.equal(observer.disconnected, true, 'an observer left connected pins its nodes');
  }
  assert.ok(revoked.length >= 1, 'and every object URL is given back');
});

test('STOP CONDITION 4: the never-started queue is bounded, not polled forever', async () => {
  await mountOpen();
  progressFixture = { queued: 0, running: 0, ok: 0, failed: 0, superseded: 0, total: 0 };
  // isProgressComplete refuses to call an empty queue finished (that is deliberate — see
  // its header), so something has to give up. It takes exactly MAX_EMPTY_POLLS.
  for (let i = 1; i < app.MAX_EMPTY_POLLS; i += 1) {
    await firePoll();
    assert.equal(pollScheduled(), true, `poll ${i} should still be trying`);
  }
  await firePoll();
  assert.equal(pollScheduled(), false, 'and then it stops rather than running for the tab’s life');
});

test('a transient progress failure retries instead of killing the run', async () => {
  await mountOpen();
  progressFixture = { queued: 1, running: 1, ok: 0, failed: 0, superseded: 0, total: 6 };
  failNext = { status: 502, payload: {} };
  await firePoll();
  assert.equal(pollScheduled(), true, 'the run is still going — do not give up on one 502');
});

test('but repeated progress failures do eventually stop', async () => {
  await mountOpen();
  progressFixture = { queued: 0, running: 0, ok: 0, failed: 0, superseded: 0, total: 0 };
  for (let i = 1; i < app.MAX_EMPTY_POLLS; i += 1) await firePoll();
  failNext = { status: 502, payload: {} };
  await firePoll();
  assert.equal(pollScheduled(), false);
});

test('the poll adopts the status the server reports', async () => {
  await mountOpen();
  progressFixture = { queued: 1, running: 0, ok: 5, failed: 0, superseded: 0, total: 6 };
  statusFixture = 'ready';
  try {
    await firePoll();
    assert.equal(els['pj-open-status'].textContent, 'ready');
  } finally {
    statusFixture = 'staging';
  }
});

// ── The results grid ─────────────────────────────────────────────────────────

test('rooms render hero first, with the scores the backend reported', async () => {
  await mountOpen();
  const [living] = findAll(els['pj-grid'], 'pj-room');
  assert.equal(find(living, 'pj-room__title').textContent, 'living room');
  const frames = findAll(living, 'pj-frame');
  assert.equal(frames.length, 2);
  assert.equal(find(frames[0], 'pj-frame__title').textContent, 'Hero frame');
  assert.ok(findAll(frames[0], 'pj-badge--hero').length, 'and carries the hero badge');
  assert.equal(find(frames[1], 'pj-frame__title').textContent, 'Frame');
  // Scores are 0-100 (what the judges emit), labelled with their scale. They used to render
  // as bare `0.91` / `0.84` through a docblock that claimed 0..1 — unlabelled, unexplained,
  // and two decimals of false precision on an integer scale.
  assert.match(textOf(frames[0]), /Quality 91 \/ 100/);
  assert.match(textOf(frames[0]), /Consistency 84 \/ 100/);
});

test('every variation is reachable, including the one on screen', async () => {
  await mountOpen();
  const [living] = findAll(els['pj-grid'], 'pj-room');
  const frames = findAll(living, 'pj-frame');
  // Both variations get a button now, not just the ones NOT being shown. Offering only the
  // alternatives left no way back to the frame you started on, and no indication of which of
  // the two you were looking at.
  const variants = findAll(frames[0], 'pj-variants__btn');
  assert.equal(variants.length, 2, 'both variations are offered');
  assert.match(textOf(frames[0]), /Variation 1 · ok/);
  assert.match(textOf(frames[0]), /Variation 2 · ok/);
});

test('a failed frame says so, with its error code — and only that frame', async () => {
  await mountOpen();
  const [living] = findAll(els['pj-grid'], 'pj-room');
  const frames = findAll(living, 'pj-frame');
  // frames[0] is the hero (ph1), whose two renders are both 'ok'; frames[1] is ph2, whose
  // only render failed. Asserting BOTH is the point: the error line is per-frame and driven
  // by the render actually on screen, so a grid that showed the failure everywhere — or
  // nowhere — would pass a one-sided check.
  assert.equal(find(frames[1], 'pj-frame__error').textContent, 'This frame failed (TIMEOUT).');
  assert.equal(find(frames[0], 'pj-frame__error').textContent, '', 'a healthy frame stays silent');
});

test('a failed variation never hides a good one', async () => {
  // The regression this pins: `sortRenders` ordered by variation and then by a RANDOM hex id,
  // never by status. So when v1 failed and v2 was fine, the card showed a broken "Image
  // unavailable" box with Status: failed, and the good render sat behind a pill the operator
  // had no reason to click.
  const previous = detailFixture.renders;
  detailFixture.renders = [
    { id: 'rf', photoId: 'ph1', variation: 1, status: 'failed', errorCode: 'TIMEOUT' },
    { id: 'rg', photoId: 'ph1', variation: 2, status: 'ok', qualityScore: 88, consistencyScore: 77 },
  ];
  try {
    await mountOpen();
    const [living] = findAll(els['pj-grid'], 'pj-room');
    const hero = findAll(living, 'pj-frame')[0];
    assert.equal(find(hero, 'pj-frame__error').textContent, '', 'the good render is the one shown');
    assert.match(textOf(hero), /Quality 88 \/ 100/);
    // The failure is still reachable rather than hidden — it is offered, not displayed.
    assert.match(textOf(hero), /Variation 1 · failed/);
  } finally {
    detailFixture.renders = previous;
  }
});

test('THE MISSING-BIBLE BANNER fires for the unconditioned room only', async () => {
  await mountOpen();
  const rooms = findAll(els['pj-grid'], 'pj-room');
  const banners = rooms.map((room) => findAll(room, 'pj-warning--loud').length);
  // living has a bible; kitchen has renders and none; unassigned has neither.
  assert.deepEqual(banners, [0, 1, 0]);
  const banner = find(rooms[1], 'pj-warning--loud');
  assert.equal(banner.textContent, 'Consistency was not enforced for this room.');
  assert.equal(banner.getAttribute('role'), 'status');
  assert.match(els['pj-progress-text'].textContent, /1 room\(s\) rendered without a look bible/);
});

test('the look bible panel shows the palette, lighting and the critical pieces', async () => {
  await mountOpen();
  const [living] = findAll(els['pj-grid'], 'pj-room');
  const bible = find(living, 'pj-bible');
  const text = textOf(bible);
  assert.match(text, /warm neutrals/);
  assert.match(text, /north light/);
  assert.match(text, /coastal/);
  assert.match(text, /low linen sofa/);
  assert.match(text, /Avoid: no chandeliers, no plants/);
  // The regression this panel actually shipped: palette/lighting are maps, and rendering
  // one straight into the DOM prints "[object Object]". Assert the stringified form is
  // nowhere in the panel, and that BOTH map entries surfaced rather than just the first.
  assert.ok(!/\[object Object\]/.test(text), 'a map must never be rendered as a raw object');
  assert.match(text, /sand linen/, 'every palette slot is shown, not just the first');
  assert.match(text, /5200K/, 'every lighting slot is shown too');
  const pieces = findAll(bible, 'pj-pieces__item');
  assert.equal(pieces.length, 3, 'including the malformed one — never silently drop a piece');
  assert.equal(pieces.filter((piece) => piece.classList.contains('is-critical')).length, 1);
  assert.equal(find(pieces[0], 'pj-badge--critical').textContent, 'Critical');
});

test('a room with no bible says so instead of showing a blank panel', async () => {
  await mountOpen();
  const rooms = findAll(els['pj-grid'], 'pj-room');
  assert.match(find(rooms[1], 'pj-bible__empty').textContent, /No look bible for this room yet/);
});

test('a bible with a string negatives list and no pieces still renders', async () => {
  const previous = detailFixture.bibles;
  detailFixture.bibles = [
    { id: 'b9', roomKey: 'living', doc: { negatives: 'no neon' } },
  ];
  try {
    await mountOpen();
    const [living] = findAll(els['pj-grid'], 'pj-room');
    const bible = find(living, 'pj-bible');
    assert.equal(findAll(bible, 'pj-pieces__item').length, 0);
    assert.match(textOf(bible), /Avoid: no neon/);
    assert.match(textOf(bible), /Version 1/, 'a missing version defaults rather than blanking');
  } finally {
    detailFixture.bibles = previous;
  }
});

test('regenerating a look warns that it supersedes, then POSTs and re-polls', async () => {
  await mountOpen();
  const [living] = findAll(els['pj-grid'], 'pj-room');
  find(living, 'pj-bible__regen').dispatch('click');
  assert.match(els['pj-confirm-title'].textContent, /Regenerate this room/);
  assert.match(els['pj-confirm-body'].textContent, /superseded/);
  assert.match(els['pj-confirm-body'].textContent, /living room/);
  requests.length = 0;
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  assert.ok(sent('POST', /\/rooms\/living\/bible\/regenerate$/));
  assert.equal(pollScheduled(), true, 'the re-run needs watching');
});

test('a failed regenerate is reported, not swallowed', async () => {
  await mountOpen();
  const [living] = findAll(els['pj-grid'], 'pj-room');
  find(living, 'pj-bible__regen').dispatch('click');
  failNext = { status: 409, payload: { error: 'already queued' } };
  assert.doesNotThrow(() => els['pj-confirm-yes'].dispatch('click'));
  await flush();
});

// ── Lazy image loading and blob ownership ────────────────────────────────────

test('images load only once scrolled into view, and the observer stops watching them', async () => {
  await mountOpen();
  const shots = findAll(els['pj-grid'], 'pj-shot');
  assert.ok(shots.length >= 3);
  for (const shot of shots) assert.equal(shot.src, undefined, 'nothing is fetched up front');

  const observer = observers.find((candidate) => candidate.observed.includes(shots[0]));
  const watchedBefore = observer.observed.length;
  observer.enter(shots[0]);
  await flush();
  assert.match(String(shots[0].src), /^blob:stub-/);
  assert.equal(observer.observed.length, watchedBefore - 1, 'and it is unobserved after loading');
});

test('a second request for a path already held reuses the URL rather than refetching', async () => {
  await mountOpen();
  const shot = find(els['pj-grid'], 'pj-shot');
  const observer = observers.find((candidate) => candidate.observed.includes(shot));
  observer.enter(shot);
  await flush();
  const first = shot.src;

  // The "After" button re-asks for the path it is already displaying.
  const [before, after] = findAll(find(els['pj-grid'], 'pj-frame'), 'pj-compare__btn');
  requests.length = 0;
  after.dispatch('click');
  await flush();
  assert.equal(shot.src, first, 'same URL');
  assert.ok(!sent('GET', /\/renders\/.*\/image$/), 'and no second fetch');
  assert.equal(before.getAttribute('aria-pressed'), 'false');
  assert.equal(after.getAttribute('aria-pressed'), 'true');
});

test('before/after swaps the image to the SOURCE photo, not another render', async () => {
  await mountOpen();
  const frame = find(els['pj-grid'], 'pj-frame');
  const [before, after] = findAll(frame, 'pj-compare__btn');
  requests.length = 0;
  before.dispatch('click');
  await flush();
  assert.ok(sent('GET', /\/photos\/ph1\/image$/), 'the before pane is the operator’s own photo');
  assert.equal(before.getAttribute('aria-pressed'), 'true');
  assert.equal(after.getAttribute('aria-pressed'), 'false');
  const shot = find(frame, 'pj-shot');
  assert.equal(shot.alt, 'Source photo');
  after.dispatch('click');
  await flush();
  assert.equal(shot.alt, 'Staged render');
});

test('an unavailable image says so rather than leaving a broken frame', async () => {
  // The route exists, but the bytes can still be gone (404) or unreachable. A blank box
  // passed off as the source photo would be a lie about what is being compared.
  await mountOpen();
  const frame = find(els['pj-grid'], 'pj-frame');
  const shot = find(frame, 'pj-shot');
  const [before] = findAll(frame, 'pj-compare__btn');
  failNext = { status: 404, payload: {} };
  before.dispatch('click');
  await flush();
  assert.ok(shot.classList.contains('pj-shot--failed'));
  assert.ok(!shot.classList.contains('pj-shot--loading'), 'and it is not left spinning');
  assert.equal(shot.alt, 'Image unavailable');
});

test('picking a variation swaps to that render', async () => {
  await mountOpen();
  const frame = find(els['pj-grid'], 'pj-frame');
  requests.length = 0;
  // Both variations are offered now, so [0] is the one already on screen. Picking THAT
  // fetches nothing (correctly — it is a no-op), so the swap has to be driven from [1].
  const variants = findAll(frame, 'pj-variants__btn');
  assert.equal(variants.length, 2);
  variants[1].dispatch('click');
  await flush();
  assert.ok(sent('GET', /\/renders\/r2\/image$/));
});

test('a redraw RETAINS the URLs still on screen instead of releasing them all', async () => {
  await mountOpen();
  const shot = find(els['pj-grid'], 'pj-shot');
  const observer = observers.find((candidate) => candidate.observed.includes(shot));
  observer.enter(shot);
  await flush();
  revoked.length = 0;

  // A poll tick redraws the whole grid. Releasing everything here is what would make a
  // 90-render listing re-download itself every 2.5 seconds.
  progressFixture = { queued: 1, running: 1, ok: 4, failed: 0, superseded: 0, total: 6 };
  await firePoll();
  assert.deepEqual(revoked, [], 'nothing still on screen was given back');
});

test('a redraw that drops a room DOES release that room’s URLs', async () => {
  await mountOpen();
  const observer = observers.find((candidate) => candidate.observed.length > 0);
  for (const shot of [...observer.observed]) observer.enter(shot);
  await flush();
  const heldBefore = revoked.length;

  const previous = detailFixture.photos;
  detailFixture.photos = [previous[0]];
  try {
    progressFixture = { queued: 0, running: 0, ok: 6, failed: 0, superseded: 0, total: 6 };
    await firePoll(); // completes → refresh → redraw with one photo
    assert.ok(revoked.length > heldBefore, 'the dropped frames gave their bytes back');
  } finally {
    detailFixture.photos = previous;
  }
});

// ── The photo tray ───────────────────────────────────────────────────────────

test('the tray counts the photos, the unstageable ones, AND the ones with no room', async () => {
  // The unassigned count is the addition that matters: `groupByRoom` silently drops a photo
  // with no `roomKey` from staging, so an operator whose clustering half-failed would have
  // paid for a listing that quietly skipped frames with nothing anywhere saying so.
  await mountOpen();
  assert.equal(
    els['pj-tray-status'].textContent,
    '4 photo(s), 1 cannot be staged, 1 with no room yet — those will NOT be staged.'
  );
});

test('an unstageable photo is shown with its rejection code, never hidden', async () => {
  await mountOpen();
  const thumbs = findAll(els['pj-tray'], 'pj-thumb');
  const flagged = thumbs.filter((thumb) => thumb.classList.contains('is-unstageable'));
  assert.equal(flagged.length, 1);
  const warning = find(flagged[0], 'pj-warning');
  // The human sentence from the language pack, not the raw taxonomy code. `PERSON_PORTRAIT`
  // told the operator nothing and the localized copy already existed in all 11 packs —
  // unstageable-message.js is the shared reader the main stager has always used.
  assert.equal(
    warning.textContent,
    englishPack.errors.unstageable.PERSON_PORTRAIT,
    'the tray shows the pack sentence, not the code',
  );
  assert.ok(!/PERSON_PORTRAIT/.test(warning.textContent), 'and never leaks the raw code');
  assert.equal(warning.getAttribute('role'), 'status');
});

test('an unstageable photo with no code still explains itself', async () => {
  const previous = detailFixture.photos;
  detailFixture.photos = [{ id: 'ph1', seq: 1, roomKey: 'living', stageable: 0 }];
  try {
    await mountOpen();
    // No code at all falls back to the pack's generic rejection sentence, which is still a
    // sentence — "unknown reason" was an apology, not an explanation.
    assert.equal(
      find(els['pj-tray'], 'pj-warning').textContent,
      englishPack.errors.unstageable.UNSTAGEABLE
    );
  } finally {
    detailFixture.photos = previous;
  }
});

test('the hero thumbnail is badged and its own button is disabled', async () => {
  await mountOpen();
  const [hero, support] = findAll(els['pj-tray'], 'pj-thumb');
  assert.equal(findAll(hero, 'pj-badge--hero').length, 1);
  const [heroBtn] = findAll(hero, 'pj-thumb__action');
  assert.equal(heroBtn.textContent, 'Hero frame');
  assert.equal(heroBtn.disabled, true);
  const [supportBtn] = findAll(support, 'pj-thumb__action');
  assert.equal(supportBtn.textContent, 'Make hero');
  assert.equal(supportBtn.disabled, false);
});

test('promoting a hero PATCHes both frames', async () => {
  await mountOpen();
  const [, support] = findAll(els['pj-tray'], 'pj-thumb');
  requests.length = 0;
  findAll(support, 'pj-thumb__action')[0].dispatch('click');
  await flush();
  const patches = requests.filter((request) => request.method === 'PATCH');
  assert.deepEqual(patches.map((patch) => [patch.path, patch.body]), [
    ['/api/projects/p1/photos/ph2', { frameRole: 'hero' }],
    ['/api/projects/p1/photos/ph1', { frameRole: 'support' }],
  ], 'promote AND demote — half of this leaves the room with two heroes');
});

test('the room override PATCHes the chosen room', async () => {
  await mountOpen();
  const [thumb] = findAll(els['pj-tray'], 'pj-thumb');
  const select = find(thumb, 'pj-thumb__room');
  const values = select.children.map((option) => option.value);
  assert.deepEqual(values, ['living', 'kitchen', '__unassigned', '__new'],
    'every room in the shoot, plus the unassigned bucket and an escape hatch');
  requests.length = 0;
  select.value = 'kitchen';
  select.dispatch('change');
  await flush();
  const patch = requests.find((request) => request.method === 'PATCH');
  assert.deepEqual([patch.path, patch.body], ['/api/projects/p1/photos/ph1', { roomKey: 'kitchen' }]);
});

test('"move to a new room" generates a key that collides with nothing', async () => {
  await mountOpen();
  const [thumb] = findAll(els['pj-tray'], 'pj-thumb');
  const select = find(thumb, 'pj-thumb__room');
  requests.length = 0;
  select.value = '__new';
  select.dispatch('change');
  await flush();
  const patch = requests.find((request) => request.method === 'PATCH');
  assert.deepEqual(patch.body, { roomKey: 'room-1' });
});

test('the room-type override PATCHes roomType, and keeps an unknown value selectable', async () => {
  const previous = detailFixture.photos;
  detailFixture.photos = [{ id: 'ph1', seq: 1, roomKey: 'living', roomType: 'wine cellar', stageable: 1 }];
  try {
    await mountOpen();
    const select = find(els['pj-tray'], 'pj-thumb__type');
    assert.ok(
      select.children.some((option) => option.value === 'wine cellar'),
      'a roomType the list does not know must not be silently reset'
    );
    assert.equal(select.value, 'wine cellar');
    requests.length = 0;
    select.value = 'bedroom';
    select.dispatch('change');
    await flush();
    const patch = requests.find((request) => request.method === 'PATCH');
    assert.deepEqual(patch.body, { roomType: 'bedroom' });
  } finally {
    detailFixture.photos = previous;
  }
});

// ── Frames the run will skip ─────────────────────────────────────────────────
// The badge exists for one failure mode: 32 photos in, 6 never render, operator concludes
// the product lost them. The rule itself is pinned against the server's in
// ./skip-reasons.test.js; these tests are about whether the tray SAYS it.

/** A listing whose four frames cover all three notices plus a frame that stages. */
const SKIP_PHOTOS = [
  { id: 'ph1', seq: 1, roomKey: 'living', roomType: OTHER_ROOM_TYPE, stageable: 1 },
  { id: 'ph2', seq: 2, roomKey: 'living', roomType: 'Bedroom', stageable: 1 },
  { id: 'ph3', seq: 3, roomKey: 'living', roomType: 'Bedroom', frameRole: 'excluded', stageable: 1 },
  { id: 'ph4', seq: 4, roomType: 'Bedroom', stageable: 1 },
];

/**
 * Run `body` against a listing of `photos`, restoring the fixture afterwards. The fixture
 * is module-scoped and shared with every other test in this file, so a spec that primes it
 * and leaves it primed is the classic unreproducible failure here.
 * @param {any[]} photos
 * @param {(thumbs: any[]) => Promise<void>|void} body
 */
async function withPhotos(photos, body) {
  const previous = detailFixture.photos;
  detailFixture.photos = photos.map((photo) => ({ ...photo, projectId: 'p1' }));
  try {
    await mountOpen();
    await body(findAll(els['pj-tray'], 'pj-thumb'));
  } finally {
    detailFixture.photos = previous;
  }
}

test('an exterior the run will skip says so, and names the room-type control as the fix', async () => {
  await withPhotos(SKIP_PHOTOS, ([exterior]) => {
    const note = find(exterior, 'pj-skip');
    assert.match(note.textContent, /not staged/i);
    assert.match(note.textContent, /exterior/i);
    // THE POINT. 'Other' is a default, not a verdict, and the override is the <select>
    // already on this card — a note that only said "not staged" would be bad news with no
    // action attached, and would invite someone to add a second control.
    assert.match(note.textContent, /room type/i);
    assert.ok(!/NOT_A_ROOM/.test(note.textContent), 'and never leaks the raw code');

    // "below" has to survive not being able to see it: the note is wired to the control
    // that undoes it.
    const type = find(exterior, 'pj-thumb__type');
    assert.equal(type.getAttribute('aria-describedby'), note.id);
    assert.ok(note.id, 'the note needs an id for the reference to resolve');
  });
});

test('a photo the run will stage carries no skip note at all', async () => {
  await withPhotos(SKIP_PHOTOS, ([, staged]) => {
    assert.equal(findAll(staged, 'pj-skip').length, 0);
    assert.equal(find(staged, 'pj-thumb__type').getAttribute('aria-describedby'), null);
  });
});

test('the excluded frame and the unassigned frame get their own, distinct notes', async () => {
  await withPhotos(SKIP_PHOTOS, ([exterior, , excluded, unassigned]) => {
    const excludedNote = find(excluded, 'pj-skip');
    const unassignedNote = find(unassigned, 'pj-skip');
    assert.match(excludedNote.textContent, /excluded/i);
    assert.match(unassignedNote.textContent, /no room/i);
    // Three reasons, three sentences. One generic "this will not be staged" everywhere
    // would tell the operator nothing they could act on.
    const texts = [find(exterior, 'pj-skip'), excludedNote, unassignedNote].map((n) => n.textContent);
    assert.equal(new Set(texts).size, 3);
    // The unassigned frame's fix is the ROOM control, not the room-type one.
    assert.equal(find(unassigned, 'pj-thumb__room').getAttribute('aria-describedby'), unassignedNote.id);
    assert.equal(find(unassigned, 'pj-thumb__type').getAttribute('aria-describedby'), null);
    // Nothing to point at for a frame the operator excluded on purpose.
    assert.equal(find(excluded, 'pj-thumb__room').getAttribute('aria-describedby'), null);
  });
});

test('setting a real room type clears the skip note, through the PATCH the tray already sends', async () => {
  const previous = detailFixture.photos;
  const realFetch = globalThis.fetch;
  detailFixture.photos = [
    { id: 'ph1', projectId: 'p1', seq: 1, roomKey: 'living', roomType: OTHER_ROOM_TYPE, stageable: 1 },
  ];
  // Let the fake server APPLY the patch, so this drives the genuine round trip — change
  // handler → PATCH → refresh → redraw — rather than asserting a redraw that was primed by
  // hand. A badge derived from a stale copy of the row is exactly the bug worth catching.
  globalThis.fetch = /** @type {any} */ (
    async (url, init = {}) => {
      if ((init.method || 'GET') === 'PATCH' && /\/photos\/[^/]+$/.test(String(url))) {
        Object.assign(detailFixture.photos[0], JSON.parse(String(init.body)));
      }
      return realFetch(url, init);
    }
  );
  try {
    await mountOpen();
    assert.equal(findAll(els['pj-tray'], 'pj-skip').length, 1);
    const select = find(els['pj-tray'], 'pj-thumb__type');
    requests.length = 0;
    select.value = 'Bedroom';
    select.dispatch('change');
    await flush();
    const patch = requests.find((request) => request.method === 'PATCH');
    assert.deepEqual(patch.body, { roomType: 'Bedroom' }, 'the existing override, not a new path');
    assert.equal(findAll(els['pj-tray'], 'pj-skip').length, 0, 'the badge must not outlive its reason');
  } finally {
    globalThis.fetch = realFetch;
    detailFixture.photos = previous;
  }
});

test('the upload gate\'s rejection sentence is not doubled by a skip note', async () => {
  // UNSTAGEABLE already has a message on this card, and it is the better one. This holds
  // even for the frame that is BOTH rejected and unassigned, where the server's own
  // first-match order would report NO_ROOM.
  await withPhotos(
    [
      { id: 'ph1', seq: 1, roomKey: 'kitchen', stageable: 0, unstageableCode: 'PERSON_PORTRAIT' },
      { id: 'ph2', seq: 2, stageable: 0, unstageableCode: 'PERSON_PORTRAIT' },
    ],
    ([rejected, alsoUnassigned]) => {
      for (const thumb of [rejected, alsoUnassigned]) {
        assert.equal(
          find(thumb, 'pj-warning').textContent,
          englishPack.errors.unstageable.PERSON_PORTRAIT,
          'the existing rejection copy is unchanged',
        );
        assert.equal(find(thumb, 'pj-warning').getAttribute('role'), 'status');
        assert.equal(findAll(thumb, 'pj-skip').length, 0, 'one message per frame, not two');
      }
    },
  );
});

test('the skip note is assembled as text, never as markup', async () => {
  // The whole tray is createElement + textContent, and the sibling islands assert this
  // property so nobody re-introduces an HTML-string sink next to operator- and
  // model-supplied values (a room type is a model output).
  await withPhotos(
    [{ id: 'ph1', seq: 1, roomKey: '<img src=x onerror=alert(1)>', roomType: OTHER_ROOM_TYPE, stageable: 1 }],
    ([thumb]) => {
      const note = find(thumb, 'pj-skip');
      assert.equal(note.innerHTML, '');
      assert.equal(note.children.length, 0);
      assert.equal(note.tagName, 'p');
      // And the hostile string the room control DOES carry stays a value, not markup.
      const room = find(thumb, 'pj-thumb__room');
      assert.equal(room.innerHTML, '');
      assert.ok(room.children.every((option) => option.innerHTML === ''));
    },
  );
});

test('removing a photo asks first, then DELETEs', async () => {
  await mountOpen();
  const [thumb] = findAll(els['pj-tray'], 'pj-thumb');
  const [, removeBtn] = findAll(thumb, 'pj-thumb__action');
  assert.equal(removeBtn.textContent, 'Remove');
  removeBtn.dispatch('click');
  assert.equal(els['pj-confirm-title'].textContent, 'Remove this photo?');
  requests.length = 0;
  els['pj-confirm-yes'].dispatch('click');
  await flush();
  assert.ok(sent('DELETE', /\/photos\/ph1$/));
});

test('tray thumbnails lazy-load too, and fall back to a no-preview state', async () => {
  await mountOpen();
  const img = find(els['pj-tray'], 'pj-thumb__img');
  const observer = observers.find((candidate) => candidate.observed.includes(img));
  assert.ok(observer, 'the tray lazy-loads a 40-photo shoot');
  failNext = { status: 404, payload: {} };
  observer.enter(img);
  await flush();
  assert.ok(img.classList.contains('pj-thumb__img--failed'));
  assert.equal(img.alt, 'No preview available');
});

// ── Intake: drag-drop, the picker, validation ────────────────────────────────

test('dragging over the dropzone highlights it, and leaving clears it', async () => {
  await mountOpen();
  const zone = els['pj-dropzone'];
  zone.dispatch('dragover', { preventDefault() {}, stopPropagation() {} });
  assert.ok(zone.classList.contains('is-over'));
  zone.dispatch('dragleave');
  assert.ok(!zone.classList.contains('is-over'));
});

test('dropping photos uploads them as one multipart batch and refreshes', async () => {
  await mountOpen();
  requests.length = 0;
  els['pj-dropzone'].dispatch('drop', {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: [fakeFile('a.jpg'), fakeFile('b.png', 'image/png')] },
  });
  // The drop handler is async now — intake runs the HEIC pass before anything is sent — so
  // the request does not exist synchronously the way it used to.
  await flush();
  const xhr = FakeXhr.last;
  assert.equal(xhr.url, '/api/projects/p1/photos');
  assert.deepEqual(xhr.body.entries.map((entry) => entry[0]), ['photos', 'photos']);

  xhr.upload.fire('progress', { lengthComputable: true, loaded: 1, total: 4 });
  assert.equal(els['pj-upload-bar'].style.width, '25%');
  assert.equal(els['pj-upload-progress'].getAttribute('aria-valuenow'), '25');

  xhr.fire('load');
  await flush();
  assert.ok(els['pj-upload-progress'].classList.contains('hidden'), 'the bar is put away');
  assert.ok(!els['pj-dropzone'].classList.contains('is-busy'));
  assert.ok(sent('GET', /^\/api\/projects\/p1$/), 'and the listing is re-read');
});

test('a dropped batch with nothing usable uploads nothing', async () => {
  await mountOpen();
  const before = FakeXhr.last;
  els['pj-dropzone'].dispatch('drop', {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: [fakeFile('raw.cr2', 'image/x-canon-cr2')] },
  });
  await flush();
  assert.equal(FakeXhr.last, before, 'no request was made');
});

test('a drop with no dataTransfer is ignored rather than throwing', async () => {
  await mountOpen();
  assert.doesNotThrow(() =>
    els['pj-dropzone'].dispatch('drop', { preventDefault() {}, stopPropagation() {} })
  );
});

test('a failed upload clears the busy state so the operator can retry', async () => {
  await mountOpen();
  els['pj-dropzone'].dispatch('drop', {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: [fakeFile()] },
  });
  await flush(); // the drop handler awaits intake before opening the request
  const xhr = FakeXhr.last;
  xhr.status = 500;
  xhr.responseText = '{}';
  xhr.fire('load');
  await flush();
  assert.ok(!els['pj-dropzone'].classList.contains('is-busy'));
  assert.ok(els['pj-upload-progress'].classList.contains('hidden'));
});

test('a second upload while one is running is refused, not queued', async () => {
  await mountOpen();
  const drop = () =>
    els['pj-dropzone'].dispatch('drop', {
      preventDefault() {},
      stopPropagation() {},
      dataTransfer: { files: [fakeFile()] },
    });
  drop();
  const first = FakeXhr.last;
  drop();
  assert.equal(FakeXhr.last, first, 'the second drop did not start a request');
  first.fire('load');
  await flush();
});

test('uploading with no listing open is refused', async () => {
  await mount({ plan: 'pro' });
  const before = FakeXhr.last;
  els['pj-dropzone'].dispatch('drop', {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: [fakeFile()] },
  });
  await flush();
  assert.equal(FakeXhr.last, before);
});

test('the dropzone opens the file picker by click and by keyboard', async () => {
  await mountOpen();
  /** @type {string[]} */
  const clicks = [];
  els['pj-file-input'].click = () => clicks.push('open');
  els['pj-dropzone'].dispatch('click');
  els['pj-dropzone'].dispatch('keydown', { key: 'Enter', preventDefault() {} });
  els['pj-dropzone'].dispatch('keydown', { key: ' ', preventDefault() {} });
  els['pj-dropzone'].dispatch('keydown', { key: 'Tab', preventDefault() {} });
  assert.deepEqual(clicks, ['open', 'open', 'open'], 'Tab must still move focus, not upload');
});

test('the file input uploads its pick and then clears itself', async () => {
  await mountOpen();
  els['pj-file-input'].files = [fakeFile()];
  els['pj-file-input'].value = 'C:\\fakepath\\a.jpg';
  els['pj-file-input'].dispatch('change');
  const xhr = FakeXhr.last;
  assert.equal(
    els['pj-file-input'].value,
    '',
    'or re-picking the same batch fires no change event'
  );
  xhr.fire('load');
  await flush();
});

test('a change event with no files is a no-op', async () => {
  await mountOpen();
  const before = FakeXhr.last;
  els['pj-file-input'].files = null;
  assert.doesNotThrow(() => els['pj-file-input'].dispatch('change'));
  await flush();
  assert.equal(FakeXhr.last, before);
});

// ── Vocabulary drift: the option VALUES must be promptMatrix keys ────────────
//
// This is the guard for the worst silent defect the Listing Studio shipped with. The tray's
// room-type options were 'living room', 'bedroom', 'kitchen' … while `promptMatrix`'s keys
// are 'Living room', 'Bedroom', 'Kitchen' — and `generatePrompt` looks them up EXACTLY and
// case-sensitively, falling through to a bare "Stage this <x> professionally." So ALL TEN
// room types and FOUR of the nine styles resolved to nothing: correcting a photo's room made
// its prompt strictly worse than leaving the wrong one, and every listing staged in
// 'industrial' silently got the generic `standard` treatment. Nothing errored, nothing
// logged, and the bill was identical.
//
// A unit test of the dropdown could not catch that — only a comparison against the server's
// own table can, which is why this reads `promptMatrix` directly rather than a copy.

test('every room-type option is an exact promptMatrix key, in matrix order', () => {
  const matrixKeys = Object.keys(promptMatrix);
  const offered = ROOM_TYPES.filter((value) => value !== OTHER_ROOM_TYPE);
  assert.deepEqual(offered, matrixKeys,
    'the room-type control must offer exactly the matrix keys, spelled and ordered as the matrix has them');
  // 'Other' is deliberately NOT a matrix key — it is the escape hatch for a space with no
  // template (hallway, garage, stairwell) and resolves to the generic prompt on purpose.
  assert.ok(!matrixKeys.includes(OTHER_ROOM_TYPE), 'Other stays outside the matrix by design');
});

test('every furniture-style option is an exact key of every room in the matrix', () => {
  const offered = FURNITURE_STYLES.map((style) => style.value);
  for (const roomType of Object.keys(promptMatrix)) {
    const styleKeys = Object.keys(promptMatrix[roomType]);
    for (const value of offered) {
      assert.ok(styleKeys.includes(value),
        `style "${value}" has no entry under promptMatrix['${roomType}'] — it would silently fall back to standard`);
    }
  }
});

test('the style <select> SHIPPED IN THE PAGE carries those values verbatim', () => {
  // The style options are static markup, not built by JS, so `vocab.js` agreeing with the
  // matrix proves nothing on its own — the page could still ship a stale hand-written list.
  // This reads projects.html itself, which is the artifact the browser actually gets.
  const html = readFileSync(new URL('../../../public/projects.html', import.meta.url), 'utf8');
  const select = html.slice(html.indexOf('id="pj-style"'));
  const block = select.slice(0, select.indexOf('</select>'));
  const shipped = [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(shipped, FURNITURE_STYLES.map((style) => style.value),
    'projects.html and vocab.js must offer the same style keys');
});

test('every element the share panel resolves is actually shipped in projects.html', () => {
  // THE PANEL FAILS SILENTLY BY DESIGN. `mountSharePanel` returns early when `#pj-share`
  // is absent, so the studio still boots on a page that never had the section — which is
  // right (a half-deployed page must not take the whole workspace down) and is exactly why
  // a typo in one id would ship as "the Share button does nothing" rather than as an error
  // anybody sees. This guard is the compensating control for that choice.
  //
  // The list is IMPORTED from the module that resolves it, never re-typed here: a
  // hand-copied second list would drift the moment someone renames a field, and would
  // still pass.
  const html = readFileSync(new URL('../../../public/projects.html', import.meta.url), 'utf8');
  const missing = SHARE_ELEMENT_IDS.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [],
    'share-panel.js resolves ids that projects.html does not ship — the panel would be inert');
});

test('the share section is inside the gated studio root, not beside it', () => {
  // #pj-root is what the plan gate and the desktop-only media query both hide. A share
  // panel mounted as a sibling would stay visible to a signed-out visitor and on a phone,
  // which is the one place a "copy your client link" button must never appear.
  const html = readFileSync(new URL('../../../public/projects.html', import.meta.url), 'utf8');
  const rootAt = html.indexOf('id="pj-root"');
  const shareAt = html.indexOf('id="pj-share"');
  const rootEnds = html.indexOf('id="pj-gate"');
  assert.ok(rootAt >= 0 && shareAt > rootAt, 'the share section must come after #pj-root opens');
  assert.ok(rootEnds < 0 || shareAt < rootEnds || rootEnds < rootAt,
    'the share section must not sit after the gate markup');
});

test('the per-photo room-type control the tray renders sends matrix keys', async () => {
  // The room-type control IS built by JS, per thumbnail, so it is checked through the DOM.
  await mountOpen();
  const [firstThumb] = findAll(els['pj-tray'], 'pj-thumb');
  assert.ok(firstThumb, 'the tray must render a thumbnail to carry the room-type control');
  const typeSelect = find(firstThumb, 'pj-thumb__type');
  const typeValues = (typeSelect.children || []).map((option) => option.value);
  // A leading '' is the "Room type…" placeholder — a photo the clusterer could not label
  // must be able to stay unlabelled rather than be silently coerced to whichever type sorts
  // first. Everything after it is a matrix key, verbatim.
  assert.deepEqual(typeValues, ['', ...ROOM_TYPES],
    'the per-photo room-type control sends matrix keys, not display text');
});
