// A no-jsdom document shim for the Exterior Studio, built from the REAL
// public/exterior-studio.html.
//
// The ids come out of the shipped markup rather than a hand-written fixture, which is the
// point: exterior-studio/access.js looks its regions up by id, and a fixture that listed
// them itself would keep passing after someone renamed one in the HTML. Here the rename
// makes getElementById return null and the assertions fail — which is the regression
// worth catching, because a null region is a silent no-op, not an error.
//
// Same shape as test/helpers/gallery-dom.js, which does this for gallery.html.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PAGE = path.join(ROOT, 'public', 'exterior-studio.html');

/** The page's markup. */
export const pageHtml = () => fs.readFileSync(PAGE, 'utf8');

/** Every `id="…"` in the page, in document order. @returns {string[]} */
export function pageIds() {
  return [...pageHtml().matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Ids whose element ships with the `hidden` attribute.
 *
 * The `|$` in the lookahead is load-bearing: the captured attribute string stops BEFORE
 * the closing `>`, so a bare `hidden` written LAST — which is where it usually ends up —
 * has nothing after it to match. Without it this silently reported "not hidden" for
 * exactly the elements most likely to be hidden.
 * @returns {Set<string>}
 */
export function hiddenPageIds() {
  const ids = new Set();
  for (const m of pageHtml().matchAll(/<[a-z]+\b([^>]*)>/gi)) {
    const attrs = m[1];
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (id && /\shidden(?=[\s>]|$)/.test(attrs)) ids.add(id);
  }
  return ids;
}

/** A minimal element stand-in: the surface access.js actually touches. */
export function fakeEl(id, { hidden = false } = {}) {
  const classes = new Set();
  /** @type {Record<string, string>} */
  const attrs = {};
  const el = {
    id,
    hidden,
    textContent: '',
    children: /** @type {any[]} */ ([]),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    removeAttribute: (k) => { delete attrs[k]; },
    // access.js finds the CTA's translated label with `querySelector('[data-lang]')`.
    querySelector: (sel) => (sel === '[data-lang]' ? el.children.find((c) => c.hasAttribute('data-lang')) || null : null),
    get classes() { return [...classes]; },
    get attrs() { return { ...attrs }; },
  };
  return el;
}

/**
 * Build a document exposing exactly the ids the real page carries, each element starting
 * in the state the markup ships it in.
 *
 * `token` and `pending` model the pre-paint gate: the head script arms
 * `html.ex-pro-pending` from a CACHED plan, and access.js only takes it off once the live
 * plan is known — which it decides by asking whether there is a token still awaiting an
 * answer. Defaulting `token` to "one exists iff a user does" keeps every existing caller
 * in the settled state they were written for.
 *
 * @param {{ user?: { plan?: string } | null, lang?: Record<string, string>, token?: string | null, pending?: boolean }} [opts] - The signed-in account to expose on window.StagifyAuth, a language pack, the stored auth token, and whether the head gate armed its class.
 * @returns {{ els: Record<string, any>, root: any, restore: () => void }}
 */
export function mountExteriorPage({ user = null, lang = {}, token = undefined, pending = false } = {}) {
  const hidden = hiddenPageIds();
  /** @type {Record<string, any>} */
  const els = {};
  for (const id of pageIds()) els[id] = fakeEl(id, { hidden: hidden.has(id) });

  // The CTA's inner <strong data-lang="…"> — the node access.js repaints.
  const ctaLabel = fakeEl('ex-cta-label');
  ctaLabel.setAttribute('data-lang', 'exteriorStudio.ctaUpgrade');
  ctaLabel.textContent = 'Get Stagify+ to use it';
  els['ex-cta']?.children.push(ctaLabel);

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;

  // <html>, carrying the class the render-blocking gate sets before first paint.
  const root = fakeEl('html');
  if (pending) root.classList.add('ex-pro-pending');

  const storedToken = token === undefined ? (user ? 'tok_test' : null) : token;

  globalThis.document = /** @type {any} */ ({
    readyState: 'complete',
    documentElement: root,
    addEventListener() {},
    removeEventListener() {},
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
  });
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: {
      user,
      isProUser: () => user?.plan === 'pro',
      getToken: () => storedToken,
    },
    LanguageSystem: { getText: (key, fallback) => (key in lang ? lang[key] : fallback) },
  });

  return {
    els,
    root,
    ctaLabel,
    restore() { globalThis.document = prevDoc; globalThis.window = prevWin; },
  };
}
