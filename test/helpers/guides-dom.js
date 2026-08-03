// DOM stand-in for the guides page (public/scripts/guides.js).
//
// Same approach as share-dom.js and gallery-dom.js: no jsdom, and the fixture is built
// from the REAL public/guides.html so it cannot drift from the markup it stands in for.
// The tab/panel wiring is parsed out of the page rather than restated here — that is the
// point, since the thing under test IS the relationship between a tab's aria-controls
// and the panel id the structured data publishes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = path.join(ROOT, 'public', 'guides.html');

/** The shipped page source. */
export function pageSource() {
  return fs.readFileSync(PAGE, 'utf8');
}

/** Every walkthrough tab in the shipped page, in document order. */
export function pageTabs() {
  const picker = /<div class="guide-demo-picker"[\s\S]*?<\/div>/.exec(pageSource());
  if (!picker) throw new Error('the .guide-demo-picker block moved — update this helper');
  return [...picker[0].matchAll(/<button\b[^>]*>/g)].map((m) => ({
    id: (/\bid="([^"]+)"/.exec(m[0]) || [])[1],
    demo: (/\bdata-demo="([^"]+)"/.exec(m[0]) || [])[1],
    controls: (/\baria-controls="([^"]+)"/.exec(m[0]) || [])[1],
    selected: (/\baria-selected="([^"]+)"/.exec(m[0]) || [])[1],
    tabindex: (/\btabindex="([^"]+)"/.exec(m[0]) || [])[1],
  }));
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
    this.offsetWidth = 640;
    this.scrolledIntoView = null;
    this.classList = {
      _set: new Set(),
      add: (...names) => names.forEach((n) => this.classList._set.add(n)),
      remove: (...names) => names.forEach((n) => this.classList._set.delete(n)),
      contains: (n) => this.classList._set.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !this.classList._set.has(n) : !!force;
        if (on) this.classList._set.add(n);
        else this.classList._set.delete(n);
        return on;
      },
    };
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  scrollIntoView(opts) { this.scrolledIntoView = opts || {}; }

  /** Invoke the listeners for `type`; returns the last return value. */
  fire(type, event = {}) {
    let last;
    for (const fn of this.listeners[type] ?? []) last = fn({ target: this, preventDefault() {}, ...event });
    return last;
  }
}

/**
 * A document + window shim wired to the real page's tabs and panels.
 * @param {{ hash?: string, reducedMotion?: boolean }} [opts]
 */
export function guidesDocument({ hash = '', reducedMotion = true } = {}) {
  const byId = new Map();
  const byClass = new Map();
  const docListeners = {};
  const winListeners = {};

  const doc = {
    activeElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) => (byClass.get(sel.replace(/^\./, '')) ?? [])[0] ?? null,
    querySelectorAll: (sel) => byClass.get(sel.replace(/^\./, '')) ?? [],
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  };

  const make = (tag, id, className) => {
    const node = new FakeEl(tag, id);
    node.ownerDocument = doc;
    node.className = className;
    for (const name of className.split(/\s+/).filter(Boolean)) {
      node.classList._set.add(name);
      if (!byClass.has(name)) byClass.set(name, []);
      byClass.get(name).push(node);
    }
    if (id) byId.set(id, node);
    return node;
  };

  const replaced = [];
  const win = {
    location: { hash },
    history: { replaceState: (_s, _t, url) => { replaced.push(url); win.location.hash = url; } },
    matchMedia: (query) => ({ matches: reducedMotion && /prefers-reduced-motion/.test(query) }),
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of winListeners[type] ?? []) fn(event); },
  };

  const tabs = pageTabs();
  const picker = make('div', '', 'guide-demo-picker');
  // querySelectorAll('[data-demo]') on the picker: the shim resolves it from the tabs
  // it just built rather than parsing a selector engine into existence.
  const tabEls = tabs.map((tab) => {
    const el = make('button', tab.id, `guide-demo-picker__btn${tab.selected === 'true' ? ' guide-demo-picker__btn--active' : ''}`);
    el.setAttribute('data-demo', tab.demo);
    el.setAttribute('aria-selected', tab.selected);
    el.setAttribute('aria-controls', tab.controls);
    el.setAttribute('tabindex', tab.tabindex);
    return el;
  });
  picker.querySelectorAll = () => tabEls;

  const panels = tabs.map((tab, i) => {
    const el = make('div', tab.controls, `guide-demo-panel${i === 0 ? ' is-active' : ''}`);
    el.setAttribute('data-demo', tab.demo);
    el.hidden = i !== 0;
    return el;
  });

  return {
    document: doc,
    window: win,
    tabs: tabEls,
    panels,
    picker,
    replacedUrls: replaced,
    tabFor: (demo) => tabEls.find((t) => t.getAttribute('data-demo') === demo),
    panelFor: (demo) => panels.find((p) => p.getAttribute('data-demo') === demo),
  };
}
