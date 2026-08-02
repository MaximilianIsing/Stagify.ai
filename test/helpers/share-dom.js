// Minimal DOM stand-in for unit-testing the public share page (public/scripts/share/*).
//
// The repo has no jsdom and deliberately doesn't want one — the house style is a
// hand-rolled shim per surface (see the same note atop test/helpers/mask-dom.js).
//
// WHAT MAKES IT TRUSTWORTHY: the element registry is built by parsing the REAL shipped
// page (public/listing-share.html) for its `id="…"` attributes, so the fixture cannot
// drift from the markup it stands in for. Rename an id in the page and the spec that
// looks it up fails, rather than quietly asserting against a stub that no longer ships.
//
// It is NOT a browser: no layout, no CSS cascade, no real event propagation. It proves
// "the module set data-state and wrote this text", never "the page looks right".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = path.join(ROOT, 'public', 'listing-share.html');

/** Every `id="…"` in the shipped share page. */
export function pageIds() {
  return [...fs.readFileSync(PAGE, 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
}

/** The raw page source, for tests that assert on the markup itself. */
export function pageSource() {
  return fs.readFileSync(PAGE, 'utf8');
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
    this._text = '';
    this.style = {
      props: {},
      setProperty(name, value) { this.props[name] = value; },
    };
    this.dataset = {};
  }

  // textContent = '' is how replaceChildren() empties a node, so it must actually clear
  // children — a shim that only stored the string would make the "no innerHTML" module
  // look like it was leaking elements.
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
  focus() { this.ownerDocument && (this.ownerDocument.activeElement = this); }

  /** Invoke the listeners registered for `type`. No bubbling — this is not a browser. */
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event });
  }

  /** Every element in this subtree, for assertions that sweep the rendered output. */
  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
}

/**
 * A document shim wired to the real page's ids.
 * @returns {{ document: any, body: any, byId: (id: string) => any }}
 */
export function shareDocument() {
  const registry = new Map();
  const doc = {
    activeElement: null,
    createElement(tag) {
      const node = new FakeEl(tag);
      node.ownerDocument = doc;
      return node;
    },
    getElementById(id) { return registry.get(id) ?? null; },
    addEventListener() { /* the Escape handler; not exercised here */ },
  };

  for (const id of pageIds()) {
    const node = new FakeEl('div', id);
    node.ownerDocument = doc;
    // The two elements the page ships hidden.
    if (id === 'sh-note' || id === 'sh-agent' || id === 'sh-lightbox') node.hidden = true;
    registry.set(id, node);
  }

  const body = new FakeEl('body');
  body.ownerDocument = doc;
  body.setAttribute('data-state', 'loading');
  doc.body = body;

  return { document: doc, body, byId: (id) => registry.get(id) ?? null };
}

/**
 * A fetch stand-in.
 * @param {{ status?: number, json?: any, throws?: boolean }} plan
 */
export function fakeFetch(plan) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (plan.throws) throw new Error('network down');
    return {
      ok: (plan.status ?? 200) >= 200 && (plan.status ?? 200) < 300,
      status: plan.status ?? 200,
      json: async () => plan.json,
    };
  };
  return Object.assign(impl, { calls });
}
