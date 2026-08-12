// Tier: frontend composition root — public/scripts/page-chrome.js.
//
// The shared entry for contact, status and guides. It exists because those three
// pages used to load scripts/app.js — index.html's whole staging application, ~228 KB
// across 32 transitive modules — to get two small effects, on pages that carry no
// #stage-modal at all.
//
// TWO THINGS ARE PINNED HERE, and both are mistakes that were actually made while
// writing this module:
//
//   1. THE CALLS HAVE TO EXIST. app/background-video.js and app/tilt-effect.js only
//      *export* their init functions — neither self-invokes. The first attempt at
//      this change pointed the three pages straight at those two files with bare
//      <script type="module"> tags, which load and parse and then do exactly nothing,
//      silently. Nothing in the suite would have caught it; the video sync would just
//      have stopped working. Hence assertions on the observable effects, not on the
//      imports.
//
//   2. THE TIMING CONTRACT. initBackgroundVideoSync() must run at module eval —
//      app/background-video.js:6 says so explicitly, because module scripts run
//      before DOMContentLoaded and that is how its DOMContentLoaded/beforeunload/
//      pagehide listeners get registered in time. init3DTiltEffect() is the opposite:
//      it queries .contact-card, so it needs a built DOM. Getting either backwards
//      fails silently rather than loudly.
//
// Plus a drift guard on the three pages themselves, so app.js cannot quietly come
// back — the regression this whole change exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Pages that load page-chrome.js instead of the staging app. */
const PAGES = ['contact.html', 'status.html', 'guides.html'];

/**
 * Install a DOM stand-in and import page-chrome.js fresh.
 *
 * The import is cache-busted (`?v=`) because the module runs its side effects at
 * eval, so a second `import()` of the same specifier would be a no-op from the ESM
 * cache and every assertion after the first case would read stale state.
 *
 * The DOM here is deliberately EMPTY — no #background-video, no .contact-card. That
 * is the real shape of status.html and guides.html, and it doubles as the null-safety
 * case: neither init may throw when its elements are absent, because a throw at
 * module eval takes down everything after it on the page.
 */
async function load({ readyState = 'loading', tag = Math.random().toString(36).slice(2) } = {}) {
  const docListeners = {};
  const winListeners = {};
  const store = new Map();

  const doc = {
    readyState,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    body: { style: {} },
  };
  // matchMedia is the tilt signal. app/tilt-effect.js is the ONLY one of the two
  // leaves that calls it (background-video.js: zero uses), and it calls it first
  // thing, so "was matchMedia reached?" answers "did init3DTiltEffect() run?"
  // exactly — without depending on how many listeners background-video registers,
  // which is an internal detail that has already changed once.
  const mediaQueries = [];
  const win = {
    addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    // Report a tilt-capable client so a "did not throw" pass cannot be a false
    // negative from the capability gate short-circuiting before it touches the DOM.
    matchMedia: (q) => { mediaQueries.push(String(q)); return { matches: !String(q).includes('prefers-reduced-motion') }; },
  };

  const storage = /** @type {any} */ ({
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });

  /**
   * Run `fn` with the stubs installed, then put the real globals back.
   *
   * Both the import AND any later hand-fired listener have to go through this: the
   * listeners close over `document`, so firing one after the globals were restored
   * reads the real (undefined) document and throws — which looks like a product bug
   * and is not one.
   */
  const withStubs = async (fn) => {
    const saved = {
      document: globalThis.document,
      window: globalThis.window,
      localStorage: globalThis.localStorage,
    };
    globalThis.document = /** @type {any} */ (doc);
    globalThis.window = /** @type {any} */ (win);
    globalThis.localStorage = storage;
    try {
      return await fn();
    } finally {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.localStorage = saved.localStorage;
    }
  };

  // Specifier written as a literal prefix + `?v=` suffix, not built from a variable:
  // that is the form untested-frontend-modules.test.js can see statically, so this
  // module counts as covered rather than being reported as untested debt.
  await withStubs(() => import(`../../public/scripts/page-chrome.js?v=${tag}`));
  // Snapshot taken at end-of-eval, before any test fires DOMContentLoaded by hand —
  // that is what makes "ran at eval" distinguishable from "ran on the event".
  const tiltRanAtEval = mediaQueries.length > 0;
  return {
    docListeners,
    winListeners,
    tiltRanAtEval,
    tiltRanNow: () => mediaQueries.length > 0,
    fireDomReady: () => withStubs(() => { for (const fn of docListeners.DOMContentLoaded || []) fn(); }),
  };
}

test('the background-video sync registers at module eval, before DOMContentLoaded', async () => {
  const { docListeners } = await load({ readyState: 'loading' });

  // initBackgroundVideoSync() registers this listener from inside its own body. Its
  // presence is the observable proof the call happened at eval — the thing a bare
  // <script src="app/background-video.js"> tag would NOT have produced, because that
  // file exports its init without invoking it.
  assert.ok(
    (docListeners.DOMContentLoaded || []).length > 0,
    'page-chrome.js must CALL initBackgroundVideoSync() at eval, not merely import it',
  );
});

test('the tilt effect waits for DOMContentLoaded while the document is still loading', async () => {
  const h = await load({ readyState: 'loading' });

  // Tilt queries .contact-card, so running it at eval would search a document that has
  // not been built yet and silently find nothing.
  assert.equal(h.tiltRanAtEval, false, 'tilt must NOT run at eval while the document is still loading');

  await h.fireDomReady();
  assert.equal(h.tiltRanNow(), true, 'tilt must run once DOMContentLoaded fires');
});

test('the tilt effect runs immediately when the document is already parsed', async () => {
  // A module script can resolve AFTER DOMContentLoaded has already fired. Without the
  // readyState branch the tilt would wait for an event that is never coming again and
  // the contact cards would simply never tilt — the silent-failure trap documented in
  // index-deferred.js:16-22. Note this case cannot be caught by firing the event by
  // hand afterwards, which is exactly why it needs its own assertion.
  const h = await load({ readyState: 'complete' });

  assert.equal(h.tiltRanAtEval, true, 'tilt must run inline when the document is already parsed');
});

test('neither init throws on a page with no #background-video and no .contact-card', async () => {
  // status.html and guides.html are exactly this shape. A throw here happens at module
  // eval and takes the rest of the page's scripts with it.
  await assert.doesNotReject(() => load({ readyState: 'complete' }));
});

test('contact, status and guides load page-chrome.js and NOT the staging app', () => {
  for (const page of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');

    assert.match(
      src,
      /<script type="module" src="scripts\/page-chrome\.js"><\/script>/,
      `${page} must load scripts/page-chrome.js`,
    );
    // The regression this change exists to prevent. app.js pulls 32 transitive modules
    // (~228 KB) and this page has no #stage-modal for any of it to act on.
    assert.doesNotMatch(
      src,
      /src="scripts\/app\.js"/,
      `${page} must NOT load scripts/app.js — it has no staging markup`,
    );
  }
});

test('page-chrome.js pulls in neither the staging pipeline nor the mask editor', () => {
  // Guards the SIZE win, not just the tag. An import added to page-chrome.js (or to
  // one of its two leaves) that reaches back into the staging graph would silently
  // undo the saving while every assertion above still passed.
  const seen = new Set();
  const queue = ['public/scripts/page-chrome.js'];
  let bytes = 0;

  while (queue.length) {
    const rel = path.normalize(queue.pop());
    if (seen.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    seen.add(rel);
    bytes += fs.statSync(abs).size;

    const src = fs.readFileSync(abs, 'utf8')
      // Strip comments first, or a commented-out import counts as a real edge — the
      // same failure mode untested-frontend-modules.test.js strips for.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const m of src.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(path.join(path.dirname(rel), m[1]));
    }
  }

  const heavy = [...seen].filter((f) => /staging-pipeline|stage-mask-editor|download-menu|furniture-refs/.test(f));
  assert.deepEqual(heavy, [], 'page-chrome.js must not reach the staging graph');

  // Generous ceiling: the graph is ~12 KB today. This is a tripwire against pulling in
  // something large, not a byte-exact pin that churns on every edit.
  assert.ok(bytes < 40 * 1024, `page-chrome.js graph grew to ${(bytes / 1024).toFixed(1)} KB (was ~12 KB)`);
});
