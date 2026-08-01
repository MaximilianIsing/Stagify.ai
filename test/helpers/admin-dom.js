// Shared fake DOM for the admin-dashboard frontend suites (public/scripts/admin.js
// and its islands). No jsdom — the same hand-rolled approach as the other
// frontend-island harnesses (auth-modal-dom.js, mask-dom.js), covering only the
// surface those modules actually touch.
//
// Not a spec: the `test` script globs `test/**/*.test.js`, so this file is imported
// by tests but never run as one.
//
// Extracted from test/frontend/admin/admin-toast.test.js, which had the only copy.
// `makeDom()`'s default behaviour is byte-for-byte what that suite relied on —
// in particular `querySelectorAll` returning `[]` — because admin.js wires itself
// in a boot IIFE and changing what it finds at import time changes what runs. A
// suite that needs class lookups opts in via `makeDom({ byClass })` rather than
// changing the default out from under the other one.

function makeClassList(node) {
  const parts = () => (node.className || '').split(' ').filter(Boolean);
  const write = (list) => { node.className = list.join(' '); };
  return {
    add(...cls) { const l = parts(); for (const c of cls) if (!l.includes(c)) l.push(c); write(l); },
    remove(...cls) { write(parts().filter((c) => !cls.includes(c))); },
    toggle(c, on) { if (on) this.add(c); else this.remove(c); },
    contains(c) { return parts().includes(c); },
  };
}

/**
 * One fake element. `handlers` records every addEventListener so a test can fire a
 * listener directly (`dispatch`), which is the only way to reach the callbacks
 * admin.js registers in its boot IIFE.
 * @param {string} tag
 */
export function makeEl(tag) {
  const node = {
    tagName: tag,
    id: '',
    className: '',
    disabled: false,
    value: '',
    files: /** @type {any} */ (null),
    style: /** @type {Record<string, string>} */ ({}),
    dataset: /** @type {Record<string, string>} */ ({}),
    attrs: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    handlers: /** @type {Record<string, Function[]>} */ ({}),
    parent: /** @type {any} */ (null),
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { if (this.parent) this.parent.removeChild(this); this.parent = null; },
    addEventListener(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); },
    click() { for (const fn of this.handlers.click || []) fn.call(this, { target: this }); },
    /** Fire every listener registered for `evt`, with `this` bound like the browser. */
    dispatch(evt, event) { for (const fn of this.handlers[evt] || []) fn.call(this, event ?? { target: this }); },
    /** admin.js reaches for `e.target.closest('.adm-tab')` in its tab handler. */
    closest(sel) { return this.classList.contains(sel.replace(/^\./, '')) ? this : null; },
  };
  // innerHTML is a real sink in renderers.js ("" to clear, markup to fill), so the
  // setter must drop the children the way the browser does.
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); node.children.length = 0; },
  });
  node.classList = makeClassList(node);
  // Setting `textContent` DETACHES a node's children in a real browser, and redraw code
  // across the app relies on exactly that to clear a container. Modelled as an accessor
  // rather than a plain property: as a plain property the old children stayed attached,
  // so a harness silently accumulated two draws and any "how many did it render" count
  // measured both at once (found while driving the Listing Studio's grid).
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

  return node;
}

/**
 * A document whose `#id` lookups materialise on demand, so a test needs no page
 * markup. getElementById does NOT auto-create — toast.js relies on a genuine miss
 * for '#toast-host' the first time, and on a hit afterwards, which is how a test can
 * assert it builds exactly one host.
 *
 * @param {{ byClass?: Record<string, any[]> }} [opts] - Optional class-selector
 *   table for `querySelectorAll('.foo')`. Omitted, every class lookup returns `[]`,
 *   which is what the toast suite is calibrated against.
 */
export function makeDom(opts = {}) {
  const byClass = opts.byClass ?? null;
  const byId = /** @type {Record<string, any>} */ ({});
  const body = makeEl('body');
  const register = (node) => { if (node && node.id) byId[node.id] = node; };
  const origAppend = body.appendChild.bind(body);
  body.appendChild = (c) => { register(c); return origAppend(c); };
  return {
    byId,
    byClass,
    body,
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ textContent: String(t), children: [] }),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => {
      if (!sel.startsWith('#')) return null;
      const id = sel.slice(1);
      if (!byId[id]) { const n = makeEl('div'); n.id = id; byId[id] = n; }
      return byId[id];
    },
    querySelectorAll: (sel) => {
      if (!byClass || typeof sel !== 'string' || !sel.startsWith('.')) return [];
      return byClass[sel.slice(1)] ?? [];
    },
  };
}

export { makeClassList };
