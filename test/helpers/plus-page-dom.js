// A no-jsdom document shim for the Stagify+ pricing page, built from the REAL
// public/stagify-plus.html.
//
// The ids come out of the shipped markup rather than a hand-written fixture, which is
// the point: scripts/stagify-plus.js looks the checkout button and its hint up by id,
// and a fixture that listed them itself would keep passing after someone renamed one in
// the HTML. Here the rename makes requireIds() fail loudly — which matters more than
// usual on this page, because a null checkout button is a silent no-op that leaves
// whatever the markup shipped on screen.
//
// Same shape as test/helpers/exterior-studio-dom.js and gallery-dom.js.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PAGE = path.join(ROOT, 'public', 'stagify-plus.html');

/** The page's markup. */
export const pageHtml = () => fs.readFileSync(PAGE, 'utf8');

/** The ids scripts/stagify-plus.js drives. */
export const PLUS_IDS = [
  'plus-checkout-hint',
  'stagify-plus-checkout-link',
  'sp-manage-subscription-wrap',
  'sp-manage-subscription-btn',
];

/** Assert every id the script depends on is still in the shipped markup. */
export function requireIds(ids = PLUS_IDS) {
  const html = pageHtml();
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `stagify-plus.html no longer ships id="${id}"`);
  }
}

/** The `<a id="stagify-plus-checkout-link" …>` open tag, as shipped. @returns {string} */
export function checkoutAnchorTag() {
  const html = pageHtml();
  const at = html.indexOf('id="stagify-plus-checkout-link"');
  assert.notEqual(at, -1, 'the checkout link moved');
  const open = html.lastIndexOf('<a', at);
  const close = html.indexOf('>', at);
  assert.ok(open !== -1 && close > open, 'could not read the checkout anchor');
  return html.slice(open, close + 1);
}

/**
 * A minimal element stand-in: the surface stagify-plus.js actually touches.
 * `href` is a real accessor over the attribute map, so removeAttribute('href') is
 * observable the way it is on a live anchor.
 * @param {string} id
 */
export function fakeEl(id) {
  const classes = new Set();
  /** @type {Record<string, string>} */
  const attrs = {};
  /** @type {Array<{ type: string, fn: Function }>} */
  const listeners = [];
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    disabled: false,
    focused: false,
    scrolled: false,
    listeners,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
    removeAttribute: (k) => {
      delete attrs[k];
    },
    hasAttribute: (k) => k in attrs,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    focus() {
      el.focused = true;
    },
    scrollIntoView() {
      el.scrolled = true;
    },
    /** Fire every listener registered for `type`. @param {string} type @param {any} [event] */
    fire(type, event = {}) {
      const e = { type, preventDefault: () => { e.defaultPrevented = true; }, defaultPrevented: false, ...event };
      for (const l of listeners) if (l.type === type) l.fn(e);
      return e;
    },
  };
  Object.defineProperty(el, 'href', {
    get: () => (attrs.href === undefined ? '' : attrs.href),
    set: (v) => {
      attrs.href = String(v);
    },
    enumerable: true,
    configurable: true,
  });
  return el;
}

/**
 * Install a fake `document` / `window` carrying the page's elements.
 * @param {{ profileMenu?: any, sessionStorage?: any }} [opts]
 */
export function mountPlusPage({ profileMenu, sessionStorage } = {}) {
  requireIds();
  /** @type {Record<string, any>} */
  const byId = {};
  for (const id of PLUS_IDS) byId[id] = fakeEl(id);

  const store = new Map();
  globalThis.document = /** @type {any} */ ({
    getElementById: (id) => byId[id] ?? null,
    addEventListener: () => {},
  });
  globalThis.window = /** @type {any} */ ({
    addEventListener: () => {},
    StagifyProfileMenu: profileMenu,
    sessionStorage: sessionStorage ?? {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  });
  return { els: byId, link: byId['stagify-plus-checkout-link'], hint: byId['plus-checkout-hint'] };
}

/** A StagifyProfileMenu double that records what the CTA asked it to do. */
export function fakeProfileMenu() {
  const calls = { openAuthModal: 0, registerMode: /** @type {boolean | null} */ (null) };
  return {
    calls,
    openAuthModal: () => {
      calls.openAuthModal += 1;
    },
    setAuthModeRegister: (on) => {
      calls.registerMode = on;
    },
  };
}
