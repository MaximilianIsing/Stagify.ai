// DOM stand-in for the owner's gallery page (public/scripts/gallery-app.js).
//
// Same approach and same reasoning as test/helpers/share-dom.js: no jsdom, and the
// element registry is parsed from the REAL public/gallery.html so the fixture cannot
// drift from the markup it stands in for. Rename an id in the page and the spec that
// looks it up fails, rather than asserting against a stub that no longer ships.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = path.join(ROOT, 'public', 'gallery.html');

/** Every `id="…"` in the shipped gallery page. */
export function pageIds() {
  return [...fs.readFileSync(PAGE, 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The ids that ship with a bare `hidden` attribute, read from the page rather than
 * listed here.
 *
 * This used to be a hard-coded array of three, which is a drift bug waiting to happen:
 * add a control that ships hidden — the pager did — and the shim starts it VISIBLE while
 * the browser starts it hidden, so a spec asserting "it is revealed" passes against a
 * fixture that was never in the state the assertion describes.
 *
 * `\shidden` and not `hidden`: `aria-hidden="true"` is a different attribute and appears
 * all over the page's SVGs.
 */
export function hiddenPageIds() {
  const src = fs.readFileSync(PAGE, 'utf8');
  return new Set(
    [...src.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/g)]
      .filter((m) => /\shidden[\s>=]/.test(m[0]))
      .map((m) => m[1]),
  );
}

class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.className = '';
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.value = '';
    this._text = '';
    this.style = { props: {}, setProperty(name, v) { this.props[name] = v; } };
    this.dataset = {};
    // The real property, because the modal's focus-restore guards on it: focusing a
    // detached node drops focus to <body>. Left undefined, that branch could never run
    // and a focus test would pass without proving anything.
    this.isConnected = true;
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  /**
   * Record the focus rather than swallow it. A no-op here made every assertion about
   * focus management vacuously true — which is the failure mode the guard in
   * test/frontend/dialog-a11y.test.js exists to catch in the source.
   */
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }

  /**
   * Invoke the listeners for `type`. Returns whatever the last one returned, so a spec
   * can `await` an async click handler rather than racing it.
   */
  fire(type, event = {}) {
    let last;
    for (const fn of this.listeners[type] ?? []) last = fn({ target: this, ...event });
    return last;
  }

  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}

/** A document shim wired to the real page's ids. */
export function galleryDocument() {
  const registry = new Map();
  const docListeners = {};
  const doc = {
    activeElement: null,
    createElement(tag) {
      const node = new FakeEl(tag);
      node.ownerDocument = doc;
      return node;
    },
    getElementById(id) { return registry.get(id) ?? null; },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of docListeners[type] ?? []) fn(event); },
  };

  const shipsHidden = hiddenPageIds();
  for (const id of pageIds()) {
    const node = new FakeEl('div', id);
    node.ownerDocument = doc;
    // The elements the page ships hidden, read from the page itself.
    if (shipsHidden.has(id)) node.hidden = true;
    registry.set(id, node);
  }

  const body = new FakeEl('body');
  body.ownerDocument = doc;
  body.setAttribute('data-state', 'loading');
  doc.body = body;

  // gallery/api.js reads the bearer token from localStorage; without a stand-in every
  // call throws before it reaches the fake fetch.
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = /** @type {any} */ ({ localStorage: { getItem: () => 'test-token' } });
  }

  return { document: doc, body, byId: (id) => registry.get(id) ?? null };
}

/**
 * A fetch stand-in routed by pathname.
 * @param {Record<string, { status: number, body: any }>} routes
 */
export function fakeRoutes(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const pathOnly = String(url).split('?')[0];
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    const plan = routes[pathOnly];
    if (!plan) return { ok: false, status: 404, json: async () => null };
    return {
      ok: plan.status >= 200 && plan.status < 300,
      status: plan.status,
      json: async () => plan.body,
    };
  };
  return Object.assign(impl, { calls });
}
