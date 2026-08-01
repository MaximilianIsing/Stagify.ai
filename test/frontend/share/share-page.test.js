// Tier: frontend island logic (DOM-stubbed) — the public share page driven the way a
// browser drives it. public/scripts/share/main.js is mounted against a hand-rolled
// document and its handlers are then dispatched at the elements they were attached to.
//
// There is no jsdom in this repo; the house style is a fake document per surface
// (test/helpers/admin-dom.js, auth-modal-dom.js, mask-dom.js). This one is local to the
// share suite because it needs three things those do not: real event BUBBLING (the frame's
// tap-to-zoom and the handle's stopPropagation only mean something if a click can travel),
// a settable `getBoundingClientRect` (the drag maths), and an `innerHTML` sink that RECORDS
// rather than accepts.
//
// THE FOUR THINGS THIS FILE EXISTS TO PIN:
//
//  1. THE XSS BOUNDARY, AS AN ASSERTION ABOUT THE API USED. The listing title, the agent's
//     name and the broker's note are operator-typed strings rendered to a stranger. The
//     test asserts both halves: the payload comes back out as TEXT, and the document
//     recorded ZERO innerHTML writes. The second half is the one that survives a rewrite —
//     "it escaped correctly today" is a weaker claim than "the code cannot emit markup".
//  2. `showBefore: false` MAKES NO SLIDER AND FETCHES NO ORIGINAL. This is a privacy
//     decision, not a layout one: the original is a photograph of somebody's actual home,
//     unstaged. The assertion sweeps every attribute in the rendered tree for `/photo/`
//     rather than checking one img, because the leak would be a URL anywhere at all.
//  3. A 404 RENDERS CALMLY AND NEVER THROWS. This page has no console anybody will read
//     and no retry. A thrown error is a permanently blank page for a seller who was asked
//     to approve something.
//  4. THE LIGHTBOX'S FOCUS CONTRACT. Focus moves in, Tab cycles, Escape closes, focus
//     returns to the control that opened it. This repo has already shipped a lightbox that
//     did none of that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_IDS, boot } from '../../../public/scripts/share/main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'listing-share.html'), 'utf8');

// Comments are stripped before any of the markup scans below. The header comments in that
// file DISCUSS the rules being checked — they contain the literal text `<script>` and the
// phrase "inline on* handlers" — so a scan of the raw source finds the documentation and
// reports it as a violation. (It did, on the first run.) Mis-stripping fails safe: it can
// only remove real markup, which makes an assertion fail rather than pass.
const PAGE = PAGE_SRC.replace(/<!--[\s\S]*?-->/g, '');

// ── The fake document ────────────────────────────────────────────────────────

/** A CSSStyleDeclaration stand-in that records custom properties too. */
function makeStyle() {
  /** @type {Record<string, string>} */
  const props = {};
  return {
    props,
    setProperty(name, value) {
      props[name] = String(value);
    },
    getPropertyValue(name) {
      return props[name] ?? '';
    },
  };
}

function makeClassList(node) {
  const parts = () => (node.className || '').split(' ').filter(Boolean);
  const write = (list) => { node.className = list.join(' '); };
  return {
    add(...cls) { const l = parts(); for (const c of cls) if (!l.includes(c)) l.push(c); write(l); },
    remove(...cls) { write(parts().filter((c) => !cls.includes(c))); },
    contains(c) { return parts().includes(c); },
  };
}

/**
 * One fake element.
 * @param {string} tag
 * @param {any} doc
 */
function makeEl(tag, doc) {
  const node = {
    tagName: tag,
    className: '',
    disabled: false,
    /** @type {Record<string, string>} */
    attributes: {},
    /** @type {Record<string, Function[]>} */
    handlers: {},
    /** @type {any[]} */
    children: [],
    /** @type {any} */
    parentNode: null,
    style: makeStyle(),
    // Zero-width by default, which is what an unlaid-out element reports; a test that
    // wants to drag the divider widens it explicitly.
    rect: { left: 0, top: 0, width: 0, height: 0 },
    getBoundingClientRect() { return node.rect; },
    setPointerCapture() {},
    setAttribute(name, value) {
      node.attributes[name] = String(value);
      if (name === 'id') node.id = String(value);
      if (name === 'class') node.className = String(value);
    },
    getAttribute(name) { return Object.hasOwn(node.attributes, name) ? node.attributes[name] : null; },
    hasAttribute(name) { return Object.hasOwn(node.attributes, name); },
    removeAttribute(name) { delete node.attributes[name]; },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) { (node.handlers[type] = node.handlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      node.handlers[type] = (node.handlers[type] || []).filter((f) => f !== fn);
    },
    focus() { doc.activeElement = node; },
  };

  let idValue = '';
  Object.defineProperty(node, 'id', {
    get: () => idValue,
    set: (value) => {
      idValue = String(value);
      node.attributes.id = idValue;
      if (idValue) doc.ids[idValue] = node;
    },
    enumerable: true,
    configurable: true,
  });

  // Setting textContent detaches children, exactly as a browser does — the renderer
  // relies on that to clear #sh-body between states.
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (value) => {
      text = value === null || value === undefined ? '' : String(value);
      node.children.length = 0;
    },
    enumerable: true,
    configurable: true,
  });

  // The markup sinks. They accept the write and RECORD it; the suite then asserts the
  // recording is empty. Making them throw would be louder but would also stop the render
  // at the first one, hiding any others.
  for (const sink of ['innerHTML', 'outerHTML']) {
    Object.defineProperty(node, sink, {
      get: () => '',
      set: (value) => { doc.htmlWrites.push({ sink, tag, value: String(value) }); },
      enumerable: true,
      configurable: true,
    });
  }
  node.insertAdjacentHTML = (position, value) => {
    doc.htmlWrites.push({ sink: 'insertAdjacentHTML', tag, value: `${position}:${value}` });
  };

  node.classList = makeClassList(node);
  return node;
}

/** A document with the share page's shell already in it. */
function makeShell() {
  const doc = /** @type {any} */ ({
    ids: {},
    /** @type {any[]} */
    htmlWrites: [],
    activeElement: null,
    title: 'Listing gallery | Stagify.ai',
    /** @type {Record<string, Function[]>} */
    handlers: {},
    addEventListener(type, fn) { (doc.handlers[type] = doc.handlers[type] || []).push(fn); },
    removeEventListener() {},
  });
  doc.createElement = (tag) => makeEl(tag, doc);
  doc.getElementById = (id) => doc.ids[id] || null;
  doc.body = doc.createElement('body');

  const root = doc.createElement('main');
  root.id = 'sh-root';
  root.setAttribute('data-state', 'loading');
  const hero = doc.createElement('header');
  const title = doc.createElement('h1');
  title.id = 'sh-title';
  title.textContent = 'Listing gallery';
  const address = doc.createElement('p');
  address.id = 'sh-address';
  const headline = doc.createElement('p');
  headline.id = 'sh-headline';
  hero.appendChild(title);
  hero.appendChild(address);
  hero.appendChild(headline);
  const body = doc.createElement('div');
  body.id = 'sh-body';
  body.setAttribute('aria-busy', 'true');
  // As in the markup. It matters to the sign-off panels, which opt OUT of it — aria-live
  // is inherited, and a fake shell without it would make that assertion vacuous.
  body.setAttribute('aria-live', 'polite');
  root.appendChild(hero);
  root.appendChild(body);
  doc.body.appendChild(root);

  return { doc, root, title, address, headline, body };
}

// ── Dispatching ──────────────────────────────────────────────────────────────

/**
 * Fire an event at `node` and let it bubble, honouring stopPropagation. Real bubbling is
 * what makes the frame's tap-to-zoom and the handle's stopPropagation testable at all.
 * @param {any} node
 * @param {string} type
 * @param {Record<string, any>} [init]
 */
function fire(node, type, init = {}) {
  let stopped = false;
  const event = {
    type,
    target: node,
    defaultPrevented: false,
    ...init,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { stopped = true; },
  };
  let current = node;
  while (current) {
    for (const fn of (current.handlers[type] || []).slice()) fn.call(current, event);
    if (stopped) break;
    current = current.parentNode;
  }
  return event;
}

// ── Tree queries ─────────────────────────────────────────────────────────────

/** @param {any} node @param {any[]} [out] */
function all(node, out = []) {
  out.push(node);
  for (const child of node.children) all(child, out);
  return out;
}

const byClass = (node, cls) => all(node).filter((n) => n.classList.contains(cls));
const byTag = (node, tag) => all(node).filter((n) => n.tagName === tag);

/** Concatenated visible text of a subtree. */
function textOf(node) {
  if (!node.children.length) return node.textContent;
  return node.children.map(textOf).join(' ');
}

/** Every attribute VALUE anywhere in the subtree — used to sweep for a leaked URL. */
function attributeValues(node) {
  return all(node).flatMap((n) => Object.values(n.attributes));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LISTING = {
  title: '12 Oak Avenue',
  address: 'Springfield, IL',
  headline: 'Four bedrooms, newly staged.',
  note: 'Have a look and tell me if anything feels off.',
  showBefore: true,
  agent: { name: 'Dana Reed', email: 'dana@example.com', phone: '+1 (555) 0100' },
  rooms: [
    {
      key: 'living-1',
      label: 'Living room',
      frames: [
        { renderId: 'r1', photoId: 'p1', width: 1536, height: 1024, arLabel: '3:2' },
        { renderId: 'r2', photoId: 'p2', width: 1536, height: 1024, arLabel: '3:2' },
      ],
    },
    {
      key: 'kitchen-1',
      label: 'Kitchen',
      frames: [{ renderId: 'r3', photoId: 'p3', width: 1024, height: 1024, arLabel: '1:1' }],
    },
  ],
  frameCount: 3,
  disclosure: 'Photos on this page have been virtually staged. Furnishings are not included.',
};

/** Deep clone so a test can mutate its own fixture. */
const listing = (patch = {}) => ({ ...structuredClone(LISTING), ...patch });

/** The reply state a link starts from: nothing said, nothing used up. */
const EMPTY_FEEDBACK = { responses: [], allowance: { used: 0, limit: 5, full: false } };

/**
 * A fetch stub standing in for the whole share API: the manifest, the feedback collection,
 * and the POST that records an answer. It records every URL it was asked for and every body
 * it was posted.
 *
 * `opts.feedback` of `null` makes BOTH feedback routes 404 — that is the older-server case,
 * and the one the reply UI has to disappear for.
 *
 * @param {any} payload - The listing manifest to serve.
 * @param {{ feedback?: any, post?: (body: any, index: number) => any }} [opts]
 */
function fetchOk(payload, opts = {}) {
  const urls = [];
  const posts = [];
  const feedback = opts.feedback === undefined ? EMPTY_FEEDBACK : opts.feedback;

  // The default server accepts everything and echoes it back, counting as it goes — the
  // shape the real endpoint documents.
  const accept = (body, index) => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      feedback: body,
      allowance: { used: index + 1, limit: 5, full: false },
    }),
  });

  const fn = async (url, init) => {
    const href = String(url);
    urls.push(href);
    if (!href.endsWith('/feedback')) {
      return { ok: true, status: 200, json: async () => ({ listing: payload }) };
    }
    if (!feedback) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      return (opts.post || accept)(body, posts.length - 1);
    }
    return { ok: true, status: 200, json: async () => feedback };
  };
  return { fn, urls, posts };
}

/** A fetch stub that answers 404 to everything, as the server does for every failure. */
function fetch404() {
  const urls = [];
  const fn = async (url) => {
    urls.push(String(url));
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  };
  return { fn, urls };
}

/**
 * Mount the page: build the shell, boot against it, hand back everything a test needs.
 * @param {{ pathname?: string, payload?: any, fetchImpl?: any, feedback?: any,
 *   post?: (body: any, index: number) => any }} [opts]
 */
async function mount(opts = {}) {
  const shell = makeShell();
  const stub = opts.fetchImpl
    ? { fn: opts.fetchImpl, urls: [], posts: [] }
    : fetchOk(opts.payload ?? listing(), opts);
  const state = await boot({
    doc: shell.doc,
    pathname: opts.pathname ?? '/s/tok-123',
    fetchImpl: /** @type {any} */ (stub.fn),
  });
  return { ...shell, state, urls: stub.urls, posts: stub.posts };
}

/**
 * Let every pending microtask chain settle. A click on a sign-off button starts an async
 * write several `await`s deep; a macrotask turn runs after all of them have drained.
 */
async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── The shell contract ───────────────────────────────────────────────────────

test('the comment strip left the markup intact (guard against a vacuous scan)', () => {
  // Every markup assertion below runs against the stripped copy. If stripping ate the
  // document, they would all pass while checking nothing.
  assert.ok(PAGE.length > 400, 'the stripped page still has a body');
  assert.ok(PAGE.includes('<main id="sh-root"'), 'and still has its shell');
  assert.ok(PAGE_SRC.includes('<!--'), 'and the source really did carry comments');
});

test('the markup provides every id the entry script resolves', () => {
  // The only coupling between listing-share.html and scripts/share/main.js, and the kind
  // that breaks silently: a renamed id renders nothing at all, with no error anywhere.
  assert.ok(REQUIRED_IDS.length >= 5);
  for (const id of REQUIRED_IDS) {
    assert.ok(PAGE.includes(`id="${id}"`), `public/listing-share.html is missing id="${id}"`);
  }
});

test('the page carries no inline script and no inline event handler', () => {
  // The site CSP forbids both, and an inline MODULE script does not error — it silently
  // does nothing, which is how this class of bug survives a manual smoke test.
  const scripts = PAGE.match(/<script\b[^>]*>/gi) || [];
  assert.equal(scripts.length, 1, 'exactly one script tag');
  assert.match(scripts[0], /\bsrc="\/scripts\/share\/main\.js"/);
  assert.match(scripts[0], /type="module"/);
  assert.equal((PAGE.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi) || []).length, 0, 'no inline script');
  assert.equal((PAGE.match(/\son[a-z]+\s*=/gi) || []).length, 0, 'no inline on* handler');
});

test('the page is a private, mobile-first document with one h1', () => {
  assert.match(PAGE, /<meta name="viewport" content="width=device-width/);
  assert.match(PAGE, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(PAGE, /<title>[^<]+<\/title>/);
  const h1s = PAGE.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi) || [];
  assert.equal(h1s.length, 1);
  assert.match(h1s[0], />\s*\S/, 'and it is not empty');
  // The studio this page's photos come from is desktop-only; this one must not be.
  assert.ok(!PAGE.includes('projects.css'), 'must not inherit the studio\'s desktop-only sheet');
});

// ── Token → request ──────────────────────────────────────────────────────────

test('the token is taken from the /s/<token> path and used for every URL', async () => {
  const page = await mount({ pathname: '/s/tok-123' });
  assert.equal(page.state, 'ready');
  assert.deepEqual(page.urls, ['/api/share/tok-123', '/api/share/tok-123/feedback']);
  const sources = attributeValues(page.root).filter((v) => v.startsWith('/api/share/'));
  assert.ok(sources.length >= 6, 'three staged + three originals');
  for (const src of sources) assert.match(src, /^\/api\/share\/tok-123\//);
});

test('a path that is not a share link renders unavailable without asking the server', async () => {
  const stub = fetchOk(listing());
  const shell = makeShell();
  const state = await boot({ doc: shell.doc, pathname: '/', fetchImpl: /** @type {any} */ (stub.fn) });
  assert.equal(state, 'unavailable');
  assert.equal(stub.urls.length, 0);
});

// ── The unavailable state ────────────────────────────────────────────────────

test('a 404 manifest renders the calm unavailable state and never throws', async () => {
  const page = await mount({ fetchImpl: fetch404().fn });
  assert.equal(page.state, 'unavailable');
  assert.equal(page.root.getAttribute('data-state'), 'unavailable');
  assert.equal(page.title.textContent, 'This link is no longer available');
  assert.equal(byClass(page.body, 'sh-message--gone').length, 1);
  assert.equal(byClass(page.body, 'sh-gallery').length, 0);
  assert.equal(page.address.getAttribute('hidden'), '', 'no stale address left on screen');
});

test('the unavailable state names no reason — the server withheld it on purpose', async () => {
  const page = await mount({
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'This share was revoked by the agent', code: 'REVOKED' }),
    }),
  });
  const shown = `${textOf(page.title)} ${textOf(page.body)}`.toLowerCase();
  for (const leak of ['revoked', 'expired', '404', 'agent']) {
    assert.ok(!shown.includes(leak), `the page must not say "${leak}"`);
  }
});

test('a rejecting fetch is the same calm state, not an unhandled rejection', async () => {
  const page = await mount({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(page.state, 'unavailable');
});

// ── Rooms and frames ─────────────────────────────────────────────────────────

test('rooms and their frames render in manifest order', async () => {
  const page = await mount();
  const rooms = byClass(page.body, 'sh-room');
  assert.deepEqual(
    rooms.map((room) => byClass(room, 'sh-room__label')[0].textContent),
    ['Living room', 'Kitchen'],
  );
  assert.deepEqual(rooms.map((room) => byClass(room, 'sh-frame').length), [2, 1]);

  // Frame order within a room, read off the staged image URLs.
  const stagedIn = (room) => byTag(room, 'img')
    .map((img) => img.getAttribute('src'))
    .filter((src) => src.includes('/render/'));
  assert.deepEqual(stagedIn(rooms[0]), [
    '/api/share/tok-123/render/r1',
    '/api/share/tok-123/render/r2',
  ]);
  assert.deepEqual(stagedIn(rooms[1]), ['/api/share/tok-123/render/r3']);
});

test('every image is lazy and carries its intrinsic size', async () => {
  // A 40-frame listing is 80 images. Lazy is what stops them all being fetched at once;
  // width/height is what stops the page reflowing under the reader's thumb as they land.
  const page = await mount();
  const images = byTag(page.root, 'img');
  assert.equal(images.length, 6, 'three staged, three originals');
  for (const img of images) {
    assert.equal(img.getAttribute('loading'), 'lazy');
    assert.equal(img.getAttribute('decoding'), 'async');
    assert.ok(img.getAttribute('width'), 'width attribute');
    assert.ok(img.getAttribute('height'), 'height attribute');
    assert.ok(img.getAttribute('alt'), 'a non-empty alt');
  }
});

test('the summary counts what was drawn', async () => {
  const page = await mount();
  assert.equal(byClass(page.body, 'sh-summary')[0].textContent, '2 rooms · 3 photos');
});

// ── The disclosure ───────────────────────────────────────────────────────────

test('the disclosure is present, verbatim, above the photographs', async () => {
  const page = await mount();
  const block = byClass(page.body, 'sh-disclosure')[0];
  assert.ok(block, 'the disclosure block is rendered');
  assert.equal(byClass(block, 'sh-disclosure__text')[0].textContent, LISTING.disclosure);
  assert.equal(block.getAttribute('role'), 'note');

  // "Above the photographs" is the legal ask, so it is asserted as an ordering, not just
  // as presence — a disclosure that renders after 24 photos is a footer with extra steps.
  const order = page.body.children.indexOf(block);
  const gallery = page.body.children.findIndex((n) => n.classList.contains('sh-gallery'));
  assert.ok(order >= 0 && gallery > order, 'the disclosure precedes the gallery');
});

// ── The before/after comparison ──────────────────────────────────────────────

test('showBefore renders a keyboard-operable slider over the original', async () => {
  const page = await mount();
  const compares = byClass(page.body, 'sh-compare');
  assert.equal(compares.length, 3, 'one per frame');

  const handle = byClass(compares[0], 'sh-compare__handle')[0];
  assert.equal(handle.tagName, 'button', 'a real button — Tab-reachable, with a focus ring');
  assert.equal(handle.getAttribute('role'), 'slider');
  assert.equal(handle.getAttribute('aria-valuenow'), '50');
  assert.ok(handle.getAttribute('aria-label'), 'the slider is named');
  assert.equal(compares[0].style.getPropertyValue('--sh-pos'), '50%');

  fire(handle, 'keydown', { key: 'ArrowLeft' });
  assert.equal(handle.getAttribute('aria-valuenow'), '46');
  assert.equal(compares[0].style.getPropertyValue('--sh-pos'), '46%');

  fire(handle, 'keydown', { key: 'ArrowRight' });
  fire(handle, 'keydown', { key: 'ArrowRight' });
  assert.equal(handle.getAttribute('aria-valuenow'), '54');

  fire(handle, 'keydown', { key: 'Home' });
  assert.equal(handle.getAttribute('aria-valuenow'), '0');
  fire(handle, 'keydown', { key: 'End' });
  assert.equal(handle.getAttribute('aria-valuenow'), '100', 'clamped at the ends, not wrapped');
});

test('showBefore:false renders no slider and requests no original photo', async () => {
  const page = await mount({ payload: listing({ showBefore: false }) });
  assert.equal(byClass(page.body, 'sh-compare').length, 0, 'no dead slider');
  assert.equal(byClass(page.body, 'sh-compare__handle').length, 0);
  assert.equal(byTag(page.root, 'img').length, 3, 'staged frames only');

  // Swept across EVERY attribute in the tree, not just img[src]: the leak this guards
  // against is a URL to somebody's unstaged home appearing anywhere at all.
  const leaked = attributeValues(page.root).filter((value) => value.includes('/photo/'));
  assert.deepEqual(leaked, []);
  assert.equal(byClass(page.body, 'sh-frame').length, 3, 'the frames still render');
});

test('a frame with no photoId falls back to the bare staged image', async () => {
  const payload = listing();
  payload.rooms[0].frames[0].photoId = null;
  const page = await mount({ payload });
  assert.equal(byClass(page.body, 'sh-compare').length, 2, 'only the two frames that can compare');
  assert.equal(byClass(page.body, 'sh-frame__plate').length, 1);
});

test('a drag on the divider does not also open the viewer', async () => {
  const page = await mount();
  const compare = byClass(page.body, 'sh-compare')[0];
  compare.rect = { left: 0, top: 0, width: 200, height: 100 };

  fire(compare, 'pointerdown', { button: 0, pointerId: 1, clientX: 100 });
  fire(compare, 'pointermove', { clientX: 30 });
  fire(compare, 'pointerup', { clientX: 30 });
  assert.equal(byClass(compare, 'sh-compare__handle')[0].getAttribute('aria-valuenow'), '15');

  const media = byClass(page.body, 'sh-frame__media')[0];
  fire(media, 'click', {});
  assert.equal(byClass(page.doc.body, 'sh-lightbox')[0].hasAttribute('hidden'), true, 'still closed');

  // …and the NEXT click, with no drag before it, is a genuine tap.
  fire(media, 'click', {});
  assert.equal(byClass(page.doc.body, 'sh-lightbox')[0].hasAttribute('hidden'), false);
});

test('a click on the handle is part of the gesture, never a request to zoom', async () => {
  const page = await mount();
  const handle = byClass(page.body, 'sh-compare__handle')[0];
  fire(handle, 'click', {});
  assert.equal(byClass(page.doc.body, 'sh-lightbox')[0].hasAttribute('hidden'), true);
});

// ── The lightbox ─────────────────────────────────────────────────────────────

/** Open the viewer from the Nth zoom button and return the pieces a test needs. */
function openViewer(page, index = 0) {
  const zooms = byClass(page.body, 'sh-frame__zoom');
  const box = byClass(page.doc.body, 'sh-lightbox')[0];
  fire(zooms[index], 'click', {});
  return {
    zooms,
    box,
    close: byClass(box, 'sh-lightbox__close')[0],
    prev: byClass(box, 'sh-lightbox__nav--prev')[0],
    next: byClass(box, 'sh-lightbox__nav--next')[0],
    counter: byClass(box, 'sh-lightbox__counter')[0],
    caption: byClass(box, 'sh-lightbox__caption')[0],
  };
}

test('the viewer announces as a modal dialog and takes focus', async () => {
  const page = await mount();
  const view = openViewer(page);
  assert.equal(view.box.getAttribute('role'), 'dialog');
  assert.equal(view.box.getAttribute('aria-modal'), 'true');
  assert.ok(view.box.getAttribute('aria-label'));
  assert.equal(view.box.hasAttribute('hidden'), false);
  assert.equal(page.doc.activeElement, view.close, 'focus moves into the dialog');
  assert.equal(page.root.getAttribute('aria-hidden'), 'true', 'the page behind is hidden from AT');
  assert.equal(view.counter.textContent, '1 of 3');
  assert.equal(view.caption.textContent, 'Living room');
});

test('the viewer navigates with arrows, buttons and a swipe, and wraps', async () => {
  const page = await mount();
  const view = openViewer(page);

  fire(view.box, 'keydown', { key: 'ArrowRight' });
  assert.equal(view.counter.textContent, '2 of 3');
  fire(view.next, 'click', {});
  assert.equal(view.counter.textContent, '3 of 3');
  assert.equal(view.caption.textContent, 'Kitchen', 'the caption follows the room');
  fire(view.box, 'keydown', { key: 'ArrowRight' });
  assert.equal(view.counter.textContent, '1 of 3', 'wraps rather than dead-ending');
  fire(view.prev, 'click', {});
  assert.equal(view.counter.textContent, '3 of 3');

  const stage = byClass(view.box, 'sh-lightbox__stage')[0];
  fire(stage, 'touchstart', { touches: [{ clientX: 300 }] });
  fire(stage, 'touchend', { changedTouches: [{ clientX: 120 }] });
  assert.equal(view.counter.textContent, '1 of 3', 'a leftward swipe advances');

  // A short drag is a scroll, not a swipe.
  fire(stage, 'touchstart', { touches: [{ clientX: 300 }] });
  fire(stage, 'touchend', { changedTouches: [{ clientX: 285 }] });
  assert.equal(view.counter.textContent, '1 of 3');
});

test('Tab cycles inside the viewer instead of walking out into the gallery', async () => {
  const page = await mount();
  const view = openViewer(page);
  const order = [view.close, view.prev, view.next];

  for (let i = 1; i <= 4; i += 1) {
    const event = fire(view.box, 'keydown', { key: 'Tab' });
    assert.equal(event.defaultPrevented, true, 'the browser default must be cancelled');
    assert.equal(page.doc.activeElement, order[i % 3], `Tab ${i}`);
  }
  fire(view.box, 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(page.doc.activeElement, view.close, 'and Shift+Tab goes back');
});

test('Escape closes the viewer and gives focus back to what opened it', async () => {
  const page = await mount();
  const view = openViewer(page, 2);
  assert.equal(view.counter.textContent, '3 of 3', 'opens on the frame that was tapped');

  fire(view.box, 'keydown', { key: 'Escape' });
  assert.equal(view.box.hasAttribute('hidden'), true);
  assert.equal(page.doc.activeElement, view.zooms[2], 'focus returns to the trigger');
  assert.equal(page.root.getAttribute('aria-hidden'), null, 'the page is readable again');
  assert.equal(page.doc.body.classList.contains('sh-locked'), false);
  assert.equal(
    byClass(view.box, 'sh-lightbox__img')[0].getAttribute('src'),
    '',
    'the full-size bytes are released',
  );
});

test('tapping the photo opens the viewer and still restores focus to a real control', async () => {
  // The media is a <div> — focus cannot go back to it, so the frame's own button is the
  // restore target even when the button was not what was tapped.
  const page = await mount();
  const media = byClass(page.body, 'sh-frame__media')[1];
  const box = byClass(page.doc.body, 'sh-lightbox')[0];
  fire(media, 'click', {});
  assert.equal(box.hasAttribute('hidden'), false);
  fire(box, 'keydown', { key: 'Escape' });
  assert.equal(page.doc.activeElement, byClass(page.body, 'sh-frame__zoom')[1]);
});

test('a single-frame listing hides the navigation rather than showing dead arrows', async () => {
  const payload = listing();
  payload.rooms = [payload.rooms[1]];
  const page = await mount({ payload });
  const view = openViewer(page);
  assert.equal(view.prev.hasAttribute('hidden'), true);
  assert.equal(view.next.hasAttribute('hidden'), true);
  fire(view.box, 'keydown', { key: 'Tab' });
  assert.equal(page.doc.activeElement, view.close, 'the trap still has somewhere to put focus');
});

// ── Operator strings ─────────────────────────────────────────────────────────

const PAYLOAD = '<img src=x onerror=alert(1)>';

test('an operator string is rendered as TEXT, and no markup sink is ever used', async () => {
  const page = await mount({
    payload: listing({
      title: PAYLOAD,
      address: `Springfield ${PAYLOAD}`,
      headline: PAYLOAD,
      note: PAYLOAD,
      agent: { name: PAYLOAD, email: 'dana@example.com', phone: '555' },
    }),
  });

  assert.equal(page.title.textContent, PAYLOAD, 'the title is the literal string');
  assert.equal(page.headline.textContent, PAYLOAD);
  assert.equal(byClass(page.body, 'sh-agent__name')[0].textContent, PAYLOAD);
  assert.equal(byClass(page.body, 'sh-note__text')[0].textContent, PAYLOAD);

  // The payload never became an element…
  const injected = byTag(page.doc.body, 'img').filter((img) => img.getAttribute('src') === 'x');
  assert.deepEqual(injected, []);
  assert.deepEqual(
    all(page.doc.body).filter((n) => n.getAttribute('onerror') !== null),
    [],
  );

  // …and, the stronger claim, the renderer never reached for an API that could make one.
  assert.deepEqual(
    page.doc.htmlWrites,
    [],
    'share/ must build the DOM with textContent and setAttribute only — see scripts/share/dom.js',
  );
});

test('a hostile string in the room label is text too, and does not break ordering', async () => {
  const payload = listing();
  payload.rooms[0].label = PAYLOAD;
  const page = await mount({ payload });
  assert.equal(byClass(page.body, 'sh-room__label')[0].textContent, PAYLOAD);
  assert.deepEqual(page.doc.htmlWrites, []);
});

// ── The agent card ───────────────────────────────────────────────────────────

test('the agent card links email and phone the way a phone expects', async () => {
  const page = await mount();
  const card = byClass(page.body, 'sh-agent')[0];
  assert.ok(card);
  assert.equal(byClass(card, 'sh-agent__name')[0].textContent, 'Dana Reed');
  const hrefs = byTag(card, 'a').map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['mailto:dana@example.com', 'tel:+15550100']);
});

test('a contact value that is not dialable or mailable is shown as plain text', async () => {
  // Escaping does not save an href: `javascript:alert(1)` survives it intact. So the
  // decision is made on the VALUE, and anything that does not look like an address or a
  // phone number simply gets no link.
  const page = await mount({
    payload: listing({
      agent: { name: 'Dana', email: 'javascript:alert(1)', phone: 'call the office' },
    }),
  });
  const card = byClass(page.body, 'sh-agent')[0];
  assert.deepEqual(byTag(card, 'a'), [], 'neither value earned a link');
  assert.deepEqual(
    byClass(card, 'sh-agent__plain').map((n) => n.textContent),
    ['javascript:alert(1)', 'call the office'],
    'but both are still shown, so the broker can see what they typed',
  );
});

test('a phone with too few digits to dial is shown, but is not a LINK', async () => {
  // Stripping is enough for safety — a tel: href can only hold [0-9+*#], so
  // `javascript:alert(2)` reduces to a harmless `tel:2`. It is not enough for sense: that
  // still renders a tappable link that opens the buyer's dialler on "2". Found by putting
  // a hostile value through the real page, not by a test.
  const page = await mount({
    payload: listing({ agent: { name: 'Dana', email: '', phone: 'javascript:alert(2)' } }),
  });
  const card = byClass(page.body, 'sh-agent')[0];
  assert.deepEqual(byTag(card, 'a'), [], 'one stray digit must not become a phone link');
  assert.deepEqual(
    byClass(card, 'sh-agent__plain').map((n) => n.textContent),
    ['javascript:alert(2)'],
    'and the broker still sees what they typed',
  );
});

test('a real phone number still links, in the shapes brokers actually type', async () => {
  // The floor has to clear every genuine number or it is worse than the bug it fixed.
  for (const phone of ['+1 (303) 555-0148', '303-555-0148', '020 7946 0958', '5550148']) {
    const page = await mount({ payload: listing({ agent: { name: 'Dana', email: '', phone } }) });
    const card = byClass(page.body, 'sh-agent')[0];
    const [link] = byTag(card, 'a');
    assert.ok(link, `${phone} must still be dialable`);
    assert.match(link.getAttribute('href'), /^tel:[0-9+*#]+$/, `${phone} -> a clean tel: URI`);
  }
});

test('no agent details means no empty card', async () => {
  const page = await mount({ payload: listing({ agent: { name: '', email: '', phone: '' } }) });
  assert.equal(byClass(page.body, 'sh-agent').length, 0);
});

// ── The empty state ──────────────────────────────────────────────────────────

test('a share with no rooms gets the empty state, not the unavailable one', async () => {
  const page = await mount({ payload: listing({ rooms: [], frameCount: 0 }) });
  assert.equal(page.state, 'empty');
  assert.equal(page.root.getAttribute('data-state'), 'empty');
  assert.equal(byClass(page.body, 'sh-message--empty').length, 1);
  assert.equal(byClass(page.body, 'sh-message--gone').length, 0);
  assert.equal(page.title.textContent, '12 Oak Avenue', 'the listing is still named');
  assert.equal(byClass(page.body, 'sh-agent').length, 1, 'and can still be replied to');
  // The disclosure is NOT shown here, and that is a deliberate reversal of what this test
  // used to assert. The sentence is a claim about the photographs on this page — "Photos on
  // this page have been virtually staged" — and a broker who shares a link before staging
  // finishes was showing it to a seller on a page with no photographs. A legal notice that
  // appears when there is nothing to disclose reads as boilerplate, which is the opposite of
  // what this sentence is for. The invariant that actually matters is asserted below.
  assert.equal(byClass(page.body, 'sh-disclosure').length, 0,
    'nothing to disclose on a page with no photographs');
});

test('NO page ever shows staged photographs without the disclosure', () => {
  // THE property. Hiding the notice on an empty page is only safe because the two are
  // driven by the SAME condition — rooms exist iff there are publishable renders — so
  // there is no state where photographs appear and the notice does not. This is what must
  // never regress; whether an empty page carries boilerplate is a judgement call, this is not.
  const source = fs.readFileSync(new URL('../../../public/scripts/share/main.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const emptyReturn = code.indexOf("return { state: 'empty'");
  const disclosureAt = code.indexOf('buildDisclosure(');
  const galleryAt = code.indexOf('buildGallery(');
  assert.ok(emptyReturn > 0 && disclosureAt > 0 && galleryAt > 0, 'all three anchors must exist');
  assert.ok(disclosureAt > emptyReturn,
    'the disclosure must be appended AFTER the empty branch returns');
  assert.ok(disclosureAt < galleryAt,
    'and BEFORE the gallery, so a viewer reads it above the photographs it describes');
});

// ── Hero fields ──────────────────────────────────────────────────────────────

test('empty hero fields are removed from the document, not merely blanked', async () => {
  const page = await mount({ payload: listing({ address: '', headline: '' }) });
  assert.equal(page.address.getAttribute('hidden'), '');
  assert.equal(page.headline.getAttribute('hidden'), '');
  assert.equal(page.title.getAttribute('hidden'), null);
});

test('a live listing settles the busy live region and titles the tab', async () => {
  const page = await mount();
  assert.equal(page.root.getAttribute('data-state'), 'ready');
  assert.equal(page.body.getAttribute('aria-busy'), 'false');
  assert.equal(page.doc.title, '12 Oak Avenue | Stagify.ai');
});

// ── Seller sign-off ──────────────────────────────────────────────────────────
//
// The reply path. The gallery is one-way without it: a broker can show a seller the
// staging but hears back in a text message the listing knows nothing about.
//
// FOUR THINGS THIS SECTION EXISTS TO PIN, in rough order of how much they cost when wrong:
//
//  1. THE ENDPOINTS ARE OPTIONAL. An older server has no /feedback route, and the page must
//     then be exactly the read-only gallery it was before — not half a form pointed at a
//     404. The GET is the capability probe, so the test drives the whole page with both
//     feedback routes 404ing and asserts the controls are ABSENT, not merely disabled.
//  2. THE TYPED NOTE SURVIVES A FAILED SEND. Somebody has written three sentences about
//     the sofa on a train with one bar of signal. The optimistic paint rolls back, but the
//     text does not — that is the failure a seller does not repeat.
//  3. A 409 IS CALM, NOT AN ERROR. Hitting the response ceiling is not the reader doing
//     something wrong, and the page must not tell them it is.
//  4. THE XSS BOUNDARY EXTENDS TO WHAT THE READER TYPED. The note and the name come back
//     from the server and are rendered to the same page; the assertion is the same pair as
//     the operator-string test above — it comes back out as TEXT, and zero markup sinks
//     were used.

/** Every sign-off panel on the page, in document order. */
const panels = (page) => byClass(page.body, 'sh-signoff');
const listingPanel = (page) => byClass(page.body, 'sh-signoff--listing')[0];
const roomPanel = (page, index) => byClass(byClass(page.body, 'sh-room')[index], 'sh-signoff')[0];

/** A button inside a panel, found by its visible label. */
const button = (node, label) => byTag(node, 'button').find((b) => b.textContent === label);

const nameField = (page) => all(page.body).find((n) => n.id === 'sh-viewer-name');
const noteField = (node) => byTag(node, 'textarea')[0];
const statusOf = (node) => byClass(node, 'sh-signoff__status')[0];

/** Type into a field the way a browser does, then fire the input event the UI listens for. */
function type(field, value) {
  field.value = value;
  fire(field, 'input', {});
}

const FEEDBACK = {
  responses: [
    { roomKey: 'living-1', verdict: 'approved', note: '', viewerLabel: 'Sam Reyes' },
    { roomKey: null, verdict: 'changes', note: 'The hallway light looks odd.', viewerLabel: 'Sam Reyes' },
  ],
  allowance: { used: 2, limit: 5, full: false },
};

test('the sign-off panels are one per room plus one for the whole listing', async () => {
  const page = await mount();
  assert.equal(panels(page).length, 3, 'two rooms and the listing');
  assert.ok(listingPanel(page), 'the whole-listing panel exists');
  assert.ok(roomPanel(page, 0) && roomPanel(page, 1), 'and each room carries its own');

  // Inside the room's <section>, not floating after the gallery: the question is about
  // the photographs immediately above it.
  assert.equal(roomPanel(page, 0).parentNode, byClass(page.body, 'sh-room')[0]);

  // The document outline stays in order: h1 title, h2 room, h3 the room's panel.
  assert.equal(byClass(roomPanel(page, 0), 'sh-signoff__heading')[0].tagName, 'h3');
  assert.equal(byClass(listingPanel(page), 'sh-signoff__heading')[0].tagName, 'h2');
});

test('the name is asked exactly once, not once per room', async () => {
  const page = await mount();
  const labels = all(page.body).filter((n) => n.tagName === 'input');
  assert.equal(labels.length, 1, 'one text field on the whole page');
  assert.equal(nameField(page).parentNode.className, 'sh-signoff__who');
  assert.ok(
    byClass(page.body, 'sh-signoff__who')[0].textContent.length === 0
      || byTag(byClass(page.body, 'sh-signoff__who')[0], 'label')[0].textContent.includes('optional'),
    'and it is offered as optional',
  );
});

test('existing responses load on boot and render as the current state', async () => {
  const page = await mount({ feedback: FEEDBACK });

  // The room that was approved shows as approved — a returning viewer is not asked again.
  const approved = roomPanel(page, 0);
  assert.equal(byClass(approved, 'sh-signoff__verdict')[0].textContent, 'You said this looks great.');
  assert.equal(byClass(approved, 'sh-signoff__verdict')[0].getAttribute('data-verdict'), 'approved');
  assert.equal(button(approved, 'Looks great'), undefined, 'and is not offered the blank form again');

  // The room that was never answered still is.
  assert.ok(button(roomPanel(page, 1), 'Looks great'));
  assert.ok(button(roomPanel(page, 1), 'Ask for a change'));

  // The whole-listing answer, note and all.
  const whole = listingPanel(page);
  assert.equal(byClass(whole, 'sh-signoff__verdict')[0].textContent, 'You asked for a change:');
  assert.equal(byClass(whole, 'sh-signoff__quote')[0].textContent, 'The hallway light looks odd.');

  // …and the name they gave last time is already in the field.
  assert.equal(nameField(page).value, 'Sam Reyes');
});

test('approving a room posts the verdict and that room\'s key, and reflects immediately', async () => {
  const page = await mount();
  const room = roomPanel(page, 0);

  fire(button(room, 'Looks great'), 'click', {});
  // BEFORE the network settles: the answer is already painted, and the status says so.
  assert.equal(byClass(room, 'sh-signoff__verdict')[0].textContent, 'You said this looks great.');
  assert.equal(statusOf(room).textContent, 'Sending…');
  assert.equal(page.posts.length, 1, 'and the write is already in flight');

  await settle();
  assert.deepEqual(page.posts, [{
    roomKey: 'living-1', verdict: 'approved', note: '', viewerLabel: '',
  }]);
  assert.match(statusOf(room).textContent, /^Saved\./);
  assert.equal(statusOf(room).getAttribute('data-tone'), null, 'success is not an error tone');
  assert.equal(byClass(roomPanel(page, 1), 'sh-signoff__verdict').length, 0, 'the other room is untouched');
});

test('the whole-listing answer posts roomKey: null', async () => {
  const page = await mount();
  fire(button(listingPanel(page), 'Looks great'), 'click', {});
  await settle();
  assert.equal(page.posts[0].roomKey, null);
});

test('"Ask for a change" sends the note and the optional name', async () => {
  const page = await mount();
  type(nameField(page), 'Dana Reed');

  const room = roomPanel(page, 1);
  fire(button(room, 'Ask for a change'), 'click', {});
  const field = noteField(room);
  assert.ok(field, 'the note form opened');
  assert.equal(page.doc.activeElement, field, 'and focus went to it');
  assert.equal(field.getAttribute('maxlength'), '500', 'clamped where the server clamps');

  type(field, 'The rug is too small for the room.');
  assert.equal(byClass(room, 'sh-signoff__counter')[0].textContent, '34 of 500 characters');

  fire(button(room, 'Send this note'), 'click', {});
  await settle();

  assert.deepEqual(page.posts, [{
    roomKey: 'kitchen-1',
    verdict: 'changes',
    note: 'The rug is too small for the room.',
    viewerLabel: 'Dana Reed',
  }]);
  assert.equal(byClass(room, 'sh-signoff__quote')[0].textContent, 'The rug is too small for the room.');
});

test('a change with no note is not sent, and the field is not thrown away', async () => {
  const page = await mount();
  const room = roomPanel(page, 0);
  fire(button(room, 'Ask for a change'), 'click', {});
  fire(button(room, 'Send this note'), 'click', {});
  await settle();

  assert.deepEqual(page.posts, [], 'nothing was sent');
  assert.equal(statusOf(room).getAttribute('data-tone'), 'error');
  assert.match(statusOf(room).textContent, /Add a short note/);
  assert.ok(noteField(room), 'and the form is still there to type into');
});

test('a rate-limited send does NOT tell the seller to try again', async () => {
  // Reachable without any abuse: each room's verdict is its own POST, so a long listing
  // plus a few revisions — or two people on one household connection — reaches
  // RL_SHARE_FEEDBACK. Measured against the real route: the limiter refuses at 30 while
  // the store's own 200-row ceiling is still far away, so 429 is the refusal a seller
  // actually meets, and the generic copy's advice ("please try again") is wrong for the
  // whole of the limiter's 15-minute window.
  const page = await mount({ post: () => ({ ok: false, status: 429, json: async () => ({}) }) });
  const room = roomPanel(page, 0);

  fire(button(room, 'Ask for a change'), 'click', {});
  type(noteField(room), 'Please try a warmer lamp.');
  fire(button(room, 'Send this note'), 'click', {});
  await settle();

  const status = statusOf(room);
  assert.equal(status.getAttribute('data-tone'), 'error');
  assert.match(status.textContent, /wait a few minutes/);
  // The discriminator. If 429 ever falls back into the generic branch again, this fails —
  // the two messages are otherwise both plausible-looking inline errors.
  assert.doesNotMatch(status.textContent, /try again/, 'the one advice that cannot work');
  // Everything the generic failure guarantees still holds; only the wording changes.
  assert.equal(byClass(room, 'sh-signoff__verdict').length, 0, 'still rolled back');
  assert.equal(noteField(room).value, 'Please try a warmer lamp.', 'and the note is still safe');
  assert.equal(page.state, 'ready');
});

test('a failed send rolls the optimistic state back and keeps what was typed', async () => {
  const page = await mount({ post: () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const room = roomPanel(page, 0);

  fire(button(room, 'Ask for a change'), 'click', {});
  type(noteField(room), 'Please try a warmer lamp.');
  fire(button(room, 'Send this note'), 'click', {});
  assert.equal(byClass(room, 'sh-signoff__verdict').length, 1, 'painted optimistically first');

  await settle();

  // Rolled back: no recorded answer…
  assert.equal(byClass(room, 'sh-signoff__verdict').length, 0);
  // …the failure is inline and quiet, not a thrown error or a replaced page…
  assert.equal(statusOf(room).getAttribute('data-tone'), 'error');
  assert.match(statusOf(room).textContent, /did not send/);
  assert.equal(page.state, 'ready');
  // …and, the thing that actually matters, the note is still in the box.
  assert.equal(noteField(room).value, 'Please try a warmer lamp.');
  assert.equal(page.doc.activeElement, noteField(room), 'with focus back where they were typing');

  // The form still works: a second attempt against a healthy server goes through.
  assert.ok(button(room, 'Send this note'), 'the send button survived the failure');
});

test('a failed approval leaves the two buttons exactly as they were', async () => {
  const page = await mount({ post: () => ({ ok: false, status: 503, json: async () => ({}) }) });
  const room = roomPanel(page, 0);
  fire(button(room, 'Looks great'), 'click', {});
  await settle();
  assert.ok(button(room, 'Looks great'), 'still offered');
  assert.ok(button(room, 'Ask for a change'));
  assert.equal(byClass(room, 'sh-signoff__verdict').length, 0, 'and nothing false left on screen');
});

test('a 409 FEEDBACK_FULL shows the calm full state across the whole page, not an error', async () => {
  const page = await mount({
    // Exactly what routes/share-feedback.js sends: an error and a code, no allowance. The
    // page must lock on the STATUS, not on a field the refusal does not carry.
    post: () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'This link has collected all the responses it can hold', code: 'FEEDBACK_FULL' }),
    }),
  });
  const room = roomPanel(page, 0);
  fire(button(room, 'Looks great'), 'click', {});
  await settle();

  for (const panel of panels(page)) {
    assert.match(byClass(panel, 'sh-signoff__full')[0].textContent, /already have your notes/);
    assert.equal(button(panel, 'Looks great'), undefined, 'no control that is guaranteed to 409');
    assert.equal(button(panel, 'Ask for a change'), undefined);
    assert.equal(statusOf(panel).getAttribute('data-tone'), null, 'a ceiling is not an error');
  }
  // The optimistic approval was rolled back rather than left showing as recorded.
  assert.equal(byClass(room, 'sh-signoff__verdict').length, 0);
  // And there is nothing left to attach a name to.
  assert.equal(nameField(page).parentNode.getAttribute('hidden'), '');
});

test('a link that arrives already at its ceiling never renders a form', async () => {
  const page = await mount({
    feedback: {
      responses: [{ roomKey: 'living-1', verdict: 'approved', note: '', viewerLabel: '' }],
      allowance: { used: 5, limit: 5, full: true },
    },
  });
  assert.equal(byTag(page.body, 'button').filter((b) => b.className.includes('sh-signoff__btn')).length, 0);
  // What was said is still shown — the ceiling hides the form, not the record.
  assert.equal(byClass(roomPanel(page, 0), 'sh-signoff__verdict')[0].textContent, 'You said this looks great.');
  assert.equal(byClass(listingPanel(page), 'sh-signoff__full').length, 1);
});

test('a 404 on the feedback endpoints degrades to the plain read-only gallery', async () => {
  // The older-server case. Not "disabled controls" — no controls, and no trace of them.
  const page = await mount({ feedback: null });
  assert.equal(page.state, 'ready');
  assert.deepEqual(page.urls, ['/api/share/tok-123', '/api/share/tok-123/feedback']);
  assert.equal(panels(page).length, 0, 'no panels');
  assert.equal(nameField(page), undefined, 'no name field');
  assert.equal(byClass(page.body, 'sh-signoff__btn').length, 0, 'no buttons');
  assert.equal(byTag(page.body, 'textarea').length, 0);
  assert.equal(byClass(page.body, 'sh-signoff-slot')[0].children.length, 0, 'the mount point stays empty');

  // …and everything the reader actually came for is untouched.
  assert.equal(byClass(page.body, 'sh-frame').length, 3);
  assert.equal(byClass(page.body, 'sh-disclosure').length, 1);
  assert.equal(byClass(page.body, 'sh-agent').length, 1);
});

/**
 * Boot a page whose /feedback probe fails a given way, leaving the manifest healthy.
 * @param {(url: string) => any} onFeedback - What the feedback endpoint does.
 * @returns {Promise<{ shell: any, state: string }>}
 */
async function bootWithBrokenProbe(onFeedback) {
  const shell = makeShell();
  const state = await boot({
    doc: shell.doc,
    pathname: '/s/tok-123',
    fetchImpl: /** @type {any} */ (async (url) => {
      if (String(url).endsWith('/feedback')) return onFeedback(String(url));
      return { ok: true, status: 200, json: async () => ({ listing: listing() }) };
    }),
  });
  return { shell, state };
}

test('a 404 on the probe hides the reply UI — that is the capability check, and it stays', async () => {
  // The ONE case that means the server does not have this feature. An older deployment must
  // still degrade to the read-only gallery: no dead buttons, no form pointed at nothing.
  const { shell, state } = await bootWithBrokenProbe(() => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.equal(state, 'ready');
  assert.equal(byClass(shell.body, 'sh-signoff').length, 0, 'no reply UI on a server without the route');
  assert.equal(byClass(shell.body, 'sh-frame').length, 3, 'the gallery still rendered');
});

test('a probe that merely FAILS still offers the reply UI — the route is there', async () => {
  // The correction. A dropped request, a 5xx, or a 429 used to be treated as "no such
  // feature" and removed the seller's only way to answer. They were sent this link to reply
  // to it; a page that silently cannot is worse than one whose send reports an error.
  for (const [label, handler] of [
    ['a dead network', () => { throw new TypeError('Failed to fetch'); }],
    ['a 500', () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['a 429', () => ({ ok: false, status: 429, json: async () => ({}) })],
  ]) {
    const { shell, state } = await bootWithBrokenProbe(/** @type {any} */ (handler));
    assert.equal(state, 'ready', label);
    assert.ok(byClass(shell.body, 'sh-signoff').length > 0, `${label}: the seller can still reply`);
    assert.equal(byClass(shell.body, 'sh-frame').length, 3, `${label}: the gallery still rendered`);
  }
});

test('an empty share is not asked for an opinion, and is not even probed', async () => {
  const page = await mount({ payload: listing({ rooms: [], frameCount: 0 }) });
  assert.equal(page.state, 'empty');
  assert.equal(panels(page).length, 0);
  assert.deepEqual(page.urls, ['/api/share/tok-123'], 'no photos, no question, no request');
});

test('a hostile note and name are rendered as TEXT, with no markup sink used', async () => {
  const page = await mount({
    feedback: {
      responses: [
        { roomKey: 'living-1', verdict: 'changes', note: PAYLOAD, viewerLabel: PAYLOAD },
        { roomKey: null, verdict: 'changes', note: `see ${PAYLOAD}`, viewerLabel: PAYLOAD },
      ],
      allowance: { used: 2, limit: 5, full: false },
    },
  });

  assert.equal(byClass(roomPanel(page, 0), 'sh-signoff__quote')[0].textContent, PAYLOAD);
  assert.equal(byClass(listingPanel(page), 'sh-signoff__quote')[0].textContent, `see ${PAYLOAD}`);
  assert.equal(nameField(page).value, PAYLOAD, 'and the name is a value, never markup');

  // The payload never became an element…
  assert.deepEqual(byTag(page.doc.body, 'img').filter((img) => img.getAttribute('src') === 'x'), []);
  assert.deepEqual(all(page.doc.body).filter((n) => n.getAttribute('onerror') !== null), []);
  // …and the stronger claim: the renderer never reached for an API that could make one.
  assert.deepEqual(page.doc.htmlWrites, [], 'the sign-off UI must build DOM the way the rest of share/ does');
});

test('a hostile note typed by the reader survives the round trip as text', async () => {
  const page = await mount();
  const room = roomPanel(page, 0);
  fire(button(room, 'Ask for a change'), 'click', {});
  type(noteField(room), PAYLOAD);
  fire(button(room, 'Send this note'), 'click', {});
  await settle();

  assert.equal(page.posts[0].note, PAYLOAD, 'sent verbatim — escaping is not this layer\'s job');
  assert.equal(byClass(room, 'sh-signoff__quote')[0].textContent, PAYLOAD);
  assert.deepEqual(page.doc.htmlWrites, []);
});

test('each panel announces its own changes in a live region', async () => {
  // Sellers use screen readers too, and the state change here is invisible otherwise: a
  // button label does not change when the answer behind it is recorded.
  const page = await mount();
  assert.match(PAGE, /id="sh-body"[^>]*aria-live="polite"/, 'the page container really is one');
  assert.equal(page.body.getAttribute('aria-live'), 'polite');
  for (const panel of panels(page)) {
    const status = statusOf(panel);
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.equal(status.textContent, '', 'built empty and left in the DOM, not created on demand');
    // …and the panel AROUND it is opted out of the page's region. aria-live is inherited,
    // so without this every button press re-announces the whole rebuilt panel on top of
    // the one sentence the status line says.
    assert.equal(panel.getAttribute('aria-live'), 'off');
  }
  const room = roomPanel(page, 0);
  fire(button(room, 'Looks great'), 'click', {});
  await settle();
  assert.ok(statusOf(room).textContent.length > 0, 'and the same element carries the announcement');
});

test('a recorded answer can be changed, and the second answer is sent too', async () => {
  const page = await mount({ feedback: FEEDBACK });
  const room = roomPanel(page, 0);
  fire(button(room, 'Change your answer'), 'click', {});
  assert.ok(button(room, 'Ask for a change'), 'back to the two choices');

  fire(button(room, 'Ask for a change'), 'click', {});
  type(noteField(room), 'On reflection, the sofa is too big.');
  fire(button(room, 'Send this note'), 'click', {});
  await settle();
  assert.equal(page.posts[0].verdict, 'changes');
  assert.equal(page.posts[0].roomKey, 'living-1');
});

test('the note counter counts, and the field cannot be typed past the server clamp', async () => {
  const page = await mount();
  const room = roomPanel(page, 0);
  fire(button(room, 'Ask for a change'), 'click', {});
  const counter = byClass(room, 'sh-signoff__counter')[0];
  assert.equal(counter.textContent, '0 of 500 characters');
  assert.equal(noteField(room).getAttribute('aria-describedby'), counter.id, 'and it is announced with the field');

  type(noteField(room), 'x'.repeat(12));
  assert.equal(counter.textContent, '12 of 500 characters');

  // A browser's maxlength stops the typing; the model clamps anything that gets past it,
  // so nobody's text is silently truncated on the server instead.
  type(noteField(room), 'y'.repeat(700));
  fire(button(room, 'Send this note'), 'click', {});
  await settle();
  assert.equal(page.posts[0].note.length, 500);
});

// ── The link preview ─────────────────────────────────────────────────────────

test('the link preview is generic, and names no listing, address or agent', async () => {
  // A broker pastes this link into iMessage, WhatsApp or Slack, all of which unfurl it
  // server-side for everyone in the thread before anybody clicks. Two hard requirements
  // meet here: a seller's home must not auto-expand in a group chat, and the shell must
  // stay byte-identical for every token so it cannot be used to test whether one is real.
  const metas = [...PAGE.matchAll(/<meta\s+(?:property|name)="((?:og|twitter):[^"]+)"\s+content="([^"]*)"/g)]
    .map((m) => ({ key: m[1], content: m[2] }));
  const keys = metas.map((m) => m.key);

  for (const required of ['og:type', 'og:title', 'og:description', 'og:url', 'og:image', 'twitter:card', 'twitter:title', 'twitter:image']) {
    assert.ok(keys.includes(required), `missing ${required}`);
  }
  assert.ok(metas.every((m) => m.content.length > 0), 'no empty preview field');

  // Nothing listing-shaped anywhere in them. These are the fixture's own strings, but the
  // point is the class: the tags are STATIC, so any of them appearing would mean somebody
  // started templating this page.
  const blob = metas.map((m) => m.content).join(' ').toLowerCase();
  for (const leak of ['oak avenue', 'springfield', 'dana reed', 'bedroom', '{{', '${']) {
    assert.ok(!blob.includes(leak), `the preview must not carry "${leak}"`);
  }
  // The URL is the site root, never /s/<token> — the token is the credential.
  assert.equal(metas.find((m) => m.key === 'og:url').content, 'https://stagify.ai/');
  assert.ok(!blob.includes('/s/'), 'and no token-shaped path anywhere in the card');

  // Absolute, and a real file: a relative og:image resolves against /s/ and unfurls blank.
  const image = metas.find((m) => m.key === 'og:image').content;
  assert.equal(image, 'https://stagify.ai/og-image.png');
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'og-image.png')), 'the image exists in public/');
  assert.equal(metas.find((m) => m.key === 'twitter:image').content, image);

  // Unfurling is not indexing, and the page stays out of search either way.
  assert.match(PAGE, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(PAGE, /<meta name="referrer" content="no-referrer">/);
});

test('the reason the preview is generic is written down next to it', async () => {
  // This is the finding most likely to be "improved" by a future reader who sees a bland
  // card and a listing title sitting right there in the manifest. The comment is the only
  // thing standing between them and a token oracle, so it is pinned like code.
  const comment = (PAGE_SRC.match(/<!--[\s\S]*?-->/g) || [])
    .find((c) => c.includes('og:') || /GENERIC ON PURPOSE/i.test(c));
  assert.ok(comment, 'the Open Graph block must carry a comment explaining itself');
  assert.match(comment, /byte-identical|oracle/i, 'it must name the token-oracle reason');
  assert.match(comment, /group chat|unfurl/i, 'and the auto-expanding-in-a-group-chat reason');
});

test('boot on a document without the shell does nothing at all', async () => {
  const stub = fetchOk(listing());
  const bare = /** @type {any} */ ({
    ids: {},
    htmlWrites: [],
    getElementById: () => null,
    createElement: () => {
      throw new Error('must not build anything');
    },
  });
  assert.equal(
    await boot({ doc: bare, pathname: '/s/tok', fetchImpl: /** @type {any} */ (stub.fn) }),
    'no-shell',
  );
  assert.equal(stub.urls.length, 0);
});
