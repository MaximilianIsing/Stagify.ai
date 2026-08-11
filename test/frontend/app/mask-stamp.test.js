// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/mask-stamp.js, the
// "Label as virtually staged" option in the Basic Mask dialog.
//
// WHY THIS ISLAND IS DIFFERENT FROM THE STAGING ONE, and therefore why it has its own suite:
// staging posts its photo to the server and gets a stamped render back, so the disclosure is
// applied where the pixels already are. Basic Mask composites its result in the BROWSER and
// downloads that canvas, so the finished image exists nowhere else — the badge costs a round
// trip to /api/stamp-image, and this file is the only thing that makes it.
//
// The assertion that matters most is the negative one: when stamping fails, NOTHING is
// saved. Falling back to the unstamped image would put an undisclosed photo on the user's
// disk under a filename they believe carries a disclosure, which is the exact exposure the
// whole feature exists to prevent (lib/image/stamp-disclosure.js fails closed for the same
// reason). A fallback here would be invisible: the download succeeds, the file looks fine,
// and only the MLS reviewer ever finds out.
//
// The browser-level proof is e2e/basic-mask.spec.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { stampIfRequested, stampRequested, downloadWithLabel } from '../../../public/scripts/app/mask-stamp.js';

const REAL = {
  document: globalThis.document,
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  Event: globalThis.Event,
};
afterEach(() => { Object.assign(globalThis, REAL); });

/** Minimal event-target stand-in. */
function node(extra = {}) {
  const listeners = new Map();
  return {
    dataset: {},
    hidden: false,
    focused: 0,
    dispatched: /** @type {string[]} */ ([]),
    addEventListener(type, fn, capture) { listeners.set(`${type}:${capture ? 'c' : 'b'}`, [...(listeners.get(`${type}:${capture ? 'c' : 'b'}`) || []), fn]); },
    fire(type, event = {}, capture = false) {
      for (const fn of listeners.get(`${type}:${capture ? 'c' : 'b'}`) || []) fn(event);
    },
    dispatchEvent(e) { this.dispatched.push(e.type); this.fire(e.type); return true; },
    focus() { this.focused += 1; },
    setAttribute(name, value) { this[`attr_${name}`] = value; },
    getAttribute(name) { return this[`attr_${name}`] ?? null; },
    hasAttribute(name) { return this[`attr_${name}`] !== undefined; },
    ...extra,
  };
}

/**
 * Build the Basic Mask disclosure control and install it as the global document.
 * @param {{ checked?: boolean, style?: string, scale?: string, lang?: string, token?: string|null }} [opts] - Starting state.
 * @returns {{ checkbox: any, opts: any, wrapper: any, docListeners: Map<string, Function[]> }} The nodes plus the document-level listeners the island installs.
 */
function mount(opts = {}) {
  const { checked = false, style = 'dark', scale = '1', lang = 'english', token = 't0k' } = opts;
  const radio = node({ value: style, checked: true });
  const slider = node({ value: scale });
  const wrapper = node({});
  const panel = node({
    hidden: !checked,
    closest: (sel) => (sel === '.stage-mask-stamp' ? wrapper : null),
    querySelector: (sel) => {
      if (sel === '.stamp-swatch__input:checked') return radio;
      if (sel === '.stamp-opts__size') return slider;
      return null;
    },
  });
  const checkbox = node({ checked, attr_aria_expanded: 'false' });

  const docListeners = new Map();
  const byId = new Map([
    ['mask-stamp-opts', panel],
    ['mask-label-virtually-staged', checkbox],
  ]);
  globalThis.document = /** @type {any} */ ({
    getElementById: (id) => byId.get(id) || null,
    addEventListener: (type, fn, capture) => {
      const key = `${type}:${capture ? 'c' : 'b'}`;
      docListeners.set(key, [...(docListeners.get(key) || []), fn]);
    },
  });
  globalThis.window = /** @type {any} */ ({ StagifyAuth: { getToken: () => token } });
  globalThis.localStorage = /** @type {any} */ ({ getItem: (k) => (k === 'selectedLanguage' ? lang : null) });
  globalThis.Event = /** @type {any} */ (class { constructor(type) { this.type = type; } });
  return { checkbox, opts: panel, wrapper, docListeners };
}

/** Install a scripted fetch and record what it was called with. */
function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return reply;
  });
  return calls;
}

const ok = (image) => ({ ok: true, status: 200, json: async () => ({ success: true, image }) });

// ---- the round trip --------------------------------------------------------

test('the option is off by default, and an unticked box costs no request at all', async () => {
  mount({ checked: false });
  const calls = stubFetch(ok('data:image/png;base64,STAMPED'));
  assert.equal(stampRequested(), false);
  assert.equal(await stampIfRequested('data:image/png;base64,ORIGINAL'), 'data:image/png;base64,ORIGINAL');
  assert.equal(calls.length, 0, 'nothing was posted — the image never left the browser');
});

test('a ticked box posts the composite and returns the stamped image', async () => {
  mount({ checked: true, style: 'banner', scale: '1.4', lang: 'german' });
  const calls = stubFetch(ok('data:image/png;base64,STAMPED'));

  const out = await stampIfRequested('data:image/png;base64,ORIGINAL');
  assert.equal(out, 'data:image/png;base64,STAMPED', 'the SERVER\'s image is what gets saved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/stamp-image');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body, {
    image: 'data:image/png;base64,ORIGINAL',
    authToken: 't0k',
    lang: 'german',
    style: 'banner',
    scale: 1.4,
  });
});

test('the badge configuration is read from the mask panel, not the page', async () => {
  // index.html carries the staging modal's copy of these same controls. Reading them
  // unscoped would stamp the download with whatever the user picked on the OTHER screen —
  // a wrong badge, chosen by nobody, with nothing on screen to show it.
  mount({ checked: true, style: 'minimal', scale: '0.7' });
  const calls = stubFetch(ok('data:image/png;base64,STAMPED'));
  await stampIfRequested('data:image/png;base64,ORIGINAL');
  assert.equal(calls[0].body.style, 'minimal');
  assert.equal(calls[0].body.scale, 0.7);
});

test('the pro session rides along, as it does for /api/mask-edit', async () => {
  mount({ checked: true });
  const calls = stubFetch(ok('data:image/png;base64,STAMPED'));
  await stampIfRequested('data:image/png;base64,ORIGINAL');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t0k');
});

test('no token means no Authorization header, rather than "Bearer null"', async () => {
  mount({ checked: true, token: null });
  const calls = stubFetch(ok('data:image/png;base64,STAMPED'));
  await stampIfRequested('data:image/png;base64,ORIGINAL');
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

// ---- failing closed --------------------------------------------------------

test('a refused stamp THROWS — it never resolves to the unstamped image', async () => {
  // The whole point. The caller in stage-mask-editor.js only skips the download because this
  // rejects; resolving with the input would save an undisclosed photo silently.
  mount({ checked: true });
  stubFetch({
    ok: false,
    status: 500,
    json: async () => ({ error: 'We couldn\'t add the "virtually staged" label…', code: 'DISCLOSURE_STAMP_FAILED' }),
  });
  await assert.rejects(
    () => stampIfRequested('data:image/png;base64,ORIGINAL'),
    (err) => {
      // The server's sentence, not a generic one: it names the option to untick, which is
      // the only action that gets the user their file.
      assert.match(err.message, /virtually staged/);
      return true;
    },
  );
});

test('a 200 with no image in it is still a failure', async () => {
  // Fail closed means closed: a malformed success is not an excuse to save the original.
  mount({ checked: true });
  stubFetch({ ok: true, status: 200, json: async () => ({ success: true }) });
  await assert.rejects(() => stampIfRequested('data:image/png;base64,ORIGINAL'));
});

test('an unparseable response is a failure, not a crash on data.image', async () => {
  mount({ checked: true });
  stubFetch({ ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } });
  await assert.rejects(() => stampIfRequested('data:image/png;base64,ORIGINAL'), /label/i);
});

// ---- the download ----------------------------------------------------------

/**
 * Let the mounted document build and collect anchors, so a test can see what was saved.
 * @returns {any[]} The anchors `downloadWithLabel` created, in order.
 */
function captureAnchors() {
  const anchors = [];
  const doc = /** @type {any} */ (globalThis.document);
  doc.createElement = () => {
    const a = node({ click() { this.clicked = (this.clicked || 0) + 1; }, remove() {} });
    anchors.push(a);
    return a;
  };
  doc.body = { appendChild: () => {} };
  return anchors;
}

test('the download saves the STAMPED bytes, under the name it was given', async () => {
  mount({ checked: true });
  stubFetch(ok('data:image/png;base64,STAMPED'));
  const anchors = captureAnchors();

  await downloadWithLabel('data:image/png;base64,ORIGINAL', 'stagify-basic-mask-1');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'data:image/png;base64,STAMPED', 'not the composite it was handed');
  assert.equal(anchors[0].download, 'stagify-basic-mask-1.png');
  assert.equal(anchors[0].clicked, 1);
});

test('the extension follows the BYTES, not the surface', async () => {
  // The Masking Studio composites JPEG but the stamp always returns PNG, so the same
  // button produces a different file type depending on whether the badge was applied.
  // Naming from the data URL is what keeps the extension honest; a hard-coded one would
  // hand someone a .jpg full of PNG bytes.
  mount({ checked: false });
  stubFetch(ok('data:image/png;base64,STAMPED'));
  const anchors = captureAnchors();
  await downloadWithLabel('data:image/jpeg;base64,ORIGINAL', 'shot');
  assert.equal(anchors[0].download, 'shot.jpg', 'unstamped keeps the composite format');

  mount({ checked: true });
  stubFetch(ok('data:image/png;base64,STAMPED'));
  const stamped = captureAnchors();
  await downloadWithLabel('data:image/jpeg;base64,ORIGINAL', 'shot');
  assert.equal(stamped[0].download, 'shot.png', 'stamped follows what the server returned');
});

test('with the option off the download is the composite itself, and no request is made', async () => {
  mount({ checked: false });
  const calls = stubFetch(ok('data:image/png;base64,STAMPED'));
  const anchors = captureAnchors();

  await downloadWithLabel('data:image/png;base64,ORIGINAL', 'x');
  assert.equal(calls.length, 0);
  assert.equal(anchors[0].href, 'data:image/png;base64,ORIGINAL');
});

test('a failed stamp saves NOTHING — no anchor, no click, no file', async () => {
  // The pairing that matters: the positive case above proves a file is written at all, so
  // this one cannot pass just because the download is broken. If stamping ever fell back to
  // the unstamped image, the user would get an undisclosed photo named as a disclosed one.
  mount({ checked: true });
  stubFetch({ ok: false, status: 500, json: async () => ({ error: 'nope', code: 'DISCLOSURE_STAMP_FAILED' }) });
  const anchors = captureAnchors();

  await assert.rejects(() => downloadWithLabel('data:image/png;base64,ORIGINAL', 'x.png'));
  assert.equal(anchors.length, 0, 'the anchor is never even built');
});

// ---- the option is not dismissible ----------------------------------------

test('NOTHING this island does can untick the box on the user behalf', async () => {
  // THE REGRESSION THIS FILE EXISTS FOR, after a click-away dismissal shipped and was
  // pulled. The checkbox IS the option, so a dismissal routed through it turns the option
  // OFF: clicking Download with the panel open fired the click-away handler, unticked the
  // box, and saved the photo unlabelled. The user asked for a disclosure, saw nothing go
  // wrong, and got a file without one.
  //
  // The escape hatch — hiding the panel WITHOUT unticking — is the other half of the trap:
  // it leaves the option on with its controls invisible, which the user can neither see nor
  // undo. So there is no dismissal at all, and the module registers no document listeners.
  const dom = mount({ checked: true });
  assert.equal(dom.docListeners.size, 0, 'no document-level keydown or pointerdown handlers');

  // Exercising the whole public surface must leave the option exactly as the user set it.
  stubFetch(ok('data:image/png;base64,STAMPED'));
  captureAnchors();
  await downloadWithLabel('data:image/png;base64,ORIGINAL', 'x');

  assert.equal(dom.checkbox.checked, true, 'still ticked after a download');
  assert.equal(stampRequested(), true);
  assert.deepEqual(dom.checkbox.dispatched, [], 'the island never fires change on it either');
});

test('the reader is safe on a page that has no such control', async () => {
  // This dialog's markup exists on pages that do not carry the disclosure option.
  globalThis.document = /** @type {any} */ ({ getElementById: () => null });
  assert.equal(stampRequested(), false, 'answers "no" rather than throwing');
  assert.equal(
    await stampIfRequested('data:image/png;base64,ORIGINAL'),
    'data:image/png;base64,ORIGINAL',
    'and passes the image straight through',
  );
});
