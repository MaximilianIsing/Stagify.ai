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
  focus() {}

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
    createElement(tag) {
      const node = new FakeEl(tag);
      node.ownerDocument = doc;
      return node;
    },
    getElementById(id) { return registry.get(id) ?? null; },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of docListeners[type] ?? []) fn(event); },
  };

  for (const id of pageIds()) {
    const node = new FakeEl('div', id);
    node.ownerDocument = doc;
    // The elements the page ships hidden.
    if (['gal-detail', 'gal-share-url', 'gal-share-revoke'].includes(id)) node.hidden = true;
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
