// Minimal DOM stand-in for unit-testing the auth modal (profile-menu/auth-modal.js).
//
// The repo has no jsdom and deliberately doesn't want one — the house style is a
// hand-rolled shim per surface (see the same note atop test/helpers/mask-dom.js).
// This one is sized to exactly what the modal touches: getElementById, one
// querySelector, classList, textContent, a few input properties, addEventListener,
// and body.insertBefore.
//
// WHAT MAKES IT TRUSTWORTHY: the element registry is built by parsing the REAL
// templates (profile-menu/*-template.js) for their `id="…"` attributes, so a
// fixture cannot drift from the markup it stands in for. If a template gains an
// element, it exists here too; if one is renamed, the spec that looks it up fails
// rather than silently asserting against a stub that no longer ships.
//
// Both profile-menu templates are registered, not just the auth modal's: the same
// dropdown raises the "Report an issue" dialog, and profile-menu.js imports both
// islands, so a spec for either needs the other's ids present.
//
// It is NOT a browser: no layout, no CSS cascade, no real event dispatch beyond
// invoking the listeners registered on a node. It proves "the module toggled
// .hidden and wrote this label", never "the panel is visible on screen".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_DIR = path.join(ROOT, 'public', 'scripts', 'profile-menu');
const TEMPLATES = ['auth-modal-template.js', 'report-issue-template.js'];

/** Every `id="…"` in the shipped profile-menu templates. */
export function templateIds() {
  const ids = [];
  for (const file of TEMPLATES) {
    const src = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
    for (const m of src.matchAll(/id="([^"]+)"/g)) ids.push(m[1]);
  }
  return ids;
}

class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const on = force === undefined ? !this.set.has(n) : !!force;
    if (on) this.set.add(n); else this.set.delete(n);
    return on;
  }
  get value() { return [...this.set].join(' '); }
}

/** The document handed to the module under test, so focus() can track activeElement. */
let installedDoc = null;

class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.classList = new ClassList();
    this.attrs = {};
    this.listeners = new Map();
    this.children = [];
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.readOnly = false;
    this.required = false;
    this.focused = false;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  /** Invoke this node's listeners for `type`. Returns a promise for async handlers. */
  emit(type, event = {}) {
    const fns = this.listeners.get(type) || [];
    return Promise.all(fns.map((fn) => fn({ preventDefault() {}, ...event })));
  }

  /** True when the module has hidden this node. */
  get hidden() { return this.classList.contains('hidden'); }

  /**
   * Focus is state here, not behaviour: `focused` is what a spec asserts on, and
   * the installed document's `activeElement` follows it so the dialogs' "remember
   * the opener, hand focus back on close" logic has something real to capture.
   */
  focus() {
    this.focused = true;
    if (installedDoc) installedDoc.activeElement = this;
  }

  /** Nothing here is ever detached, so the isConnected guards take their real path. */
  get isConnected() { return true; }

  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child) { this.children.unshift(child); return child; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
}

/**
 * Install a fake `document` / `window` for the auth modal and return handles.
 *
 * @param {{ user?: any, token?: string|null, fetchImpl?: Function, extraIds?: string[],
 *          readyState?: string, href?: string }} [opts]
 * @returns {{
 *   el: (id: string) => any,
 *   toggleEl: any,
 *   background: { header: any, main: any, footer: any },
 *   document: any,
 *   window: any,
 *   calls: { setToken: any[], fetchMe: number, applyUserToUI: number, refresh: number, closeDropdown: number },
 *   emitDocument: (type: string, event?: object) => Promise<any[]>,
 *   restore: () => void,
 * }}
 */
export function installAuthModalDom(opts = {}) {
  const registry = new Map();
  for (const id of templateIds()) registry.set(id, new FakeEl('div', id));
  // Ids outside the modal template — the profile dropdown's own markup, say.
  for (const id of opts.extraIds || []) registry.set(id, new FakeEl('div', id));

  // The one element the modal reaches for by selector rather than id.
  const toggleEl = new FakeEl('div');

  // `<body>`'s child list, which is how the modal decides what to make inert: every
  // direct child except itself (public/scripts/inert-background.js). The real page has
  // the modal first — profile-menu.js inserts it with body.insertBefore(…, firstChild)
  // — followed by the page chrome, so the fixture is seeded in that order. Without
  // background siblings here, backgroundOf() would return [] and every inert assertion
  // would pass against an empty list.
  const body = new FakeEl('body');
  const background = {
    header: new FakeEl('header', 'page-header'),
    main: new FakeEl('main', 'page-main'),
    footer: new FakeEl('footer', 'page-footer'),
  };
  body.children.push(registry.get('auth-modal'), background.header, background.main, background.footer);

  const docListeners = new Map();
  const doc = {
    body,
    readyState: opts.readyState || 'complete',
    /** Updated by FakeEl.focus(); the dialogs capture it as the element to restore to. */
    activeElement: null,
    getElementById: (id) => registry.get(id) || null,
    querySelector: (sel) => (sel === '#auth-modal .auth-toggle' ? toggleEl : null),
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const calls = { setToken: [], fetchMe: 0, applyUserToUI: 0, refresh: 0, closeDropdown: 0, cleared: 0 };
  const winListeners = new Map();
  const win = {
    StagifyAuth: {
      user: opts.user ?? null,
      getToken: () => (win.StagifyAuth.user ? opts.token ?? 'tok_test' : opts.token ?? null),
      setToken: (t) => calls.setToken.push(t),
      fetchMe: async () => { calls.fetchMe += 1; },
      applyUserToUI: () => { calls.applyUserToUI += 1; },
      clear: () => { calls.cleared += 1; win.StagifyAuth.user = null; },
    },
    // Read by anything that reports where the user was — the bug-report body, say.
    location: { href: opts.href || 'https://stagify.ai/index.html' },
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  globalThis.document = doc;
  globalThis.window = win;
  installedDoc = doc;
  // Default: every network call fails the test loudly rather than hitting the
  // real internet if a spec forgets to stub one.
  globalThis.fetch = opts.fetchImpl || (async () => { throw new Error('unexpected fetch in auth-modal test'); });

  return {
    el: (id) => registry.get(id) || null,
    toggleEl,
    /** The `<body>` siblings the modal should take out of the tree while it is open. */
    background,
    document: doc,
    window: win,
    calls,
    /** Fire a document-level listener (Escape handling lives on `document`). */
    emitDocument(type, event = {}) {
      const fns = docListeners.get(type) || [];
      return Promise.all(fns.map((fn) => fn({ preventDefault() {}, ...event })));
    },
    restore() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.fetch = saved.fetch;
    },
  };
}
