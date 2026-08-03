// Tier: frontend gate behaviour — public/scripts/gallery-gate.js.
//
// The gallery is a desktop feature AND a signed-in one. Each rule is enforced twice:
// the nav tab is `desktop-only` (a width) and ships `hidden` until auth answers (a
// person), and this gate turns away anyone who reaches /gallery.html anyway. The
// pairing of the width halves, and the breakpoint they share, live in
// test/frontend/desktop-only-gates.test.js; the tab's own writer is covered by
// gallery-tab.test.js. This file owns what only the gate can answer — that each
// redirect actually fires, and that neither fires for a signed-in desktop visitor.
//
// The gate is a classic render-blocking IIFE with no exports (a type="module" would be
// deferred past the paint it exists to beat), so it cannot be imported. The SHIPPED
// SOURCE is run here with `window`, `location` and `localStorage` passed in as
// parameters, which shadow the globals of the same name inside it — the same technique
// test/i18n/locale-data.test.js uses on the two studio gates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = path.join(ROOT, 'public', 'scripts', 'gallery-gate.js');
const PAGE = path.join(ROOT, 'public', 'gallery.html');

const gateSource = fs.readFileSync(GATE, 'utf8');

/**
 * A matchMedia that answers from a width, so the QUERY is under test too: a gate that
 * asked for something other than a max-width (a `pointer:coarse`, which a touchscreen
 * laptop also matches) fails here rather than passing on a stub that says yes to
 * everything.
 *
 * @param {number} width
 */
function matchMediaFor(width) {
  return (query) => {
    const m = /\(\s*max-width:\s*(\d+)px\s*\)/.exec(query);
    assert.ok(m, `the gate asked a media query this stub cannot answer: ${query}`);
    return { matches: width <= Number(m[1]) };
  };
}

/**
 * Run the real gate. Signed in by default, so a test that is about the width says
 * only the width.
 *
 * @param {{ width?: number, token?: string|null, matchMedia?: any, storage?: any }} opts
 * @returns {string[]} every URL it tried to replace the page with
 */
function runGate({ width = 1440, token = 'tok-user', matchMedia, storage } = {}) {
  const redirects = [];
  const win = {
    location: { replace: (target) => redirects.push(String(target)) },
    // `undefined` here is the ancient-browser case, not "no match".
    matchMedia: matchMedia === undefined ? matchMediaFor(width) : matchMedia,
  };
  const store = storage === undefined ? { getItem: () => token } : storage;
  new Function('window', 'location', 'localStorage', gateSource)(win, { pathname: '/gallery.html' }, store);
  return redirects;
}

// ── PC only ──────────────────────────────────────────────────────────────────

test('a phone-sized viewport is sent to the home page', () => {
  assert.deepEqual(runGate({ width: 393 }), ['index.html']);
});

test('768px is inside the rule and 769px is outside it', () => {
  assert.deepEqual(runGate({ width: 768 }), ['index.html']);
  assert.deepEqual(runGate({ width: 769 }), []);
});

test('a browser with no matchMedia fails OPEN', () => {
  // Hiding someone's own saved renders because their browser cannot be measured is
  // the worse failure of the two. The token check below still applies.
  assert.deepEqual(runGate({ matchMedia: null }), []);
});

// ── signed in only ───────────────────────────────────────────────────────────

test('a signed-out desktop visitor is sent to the home page', () => {
  assert.deepEqual(runGate({ width: 1440, token: null }), ['index.html']);
});

test('a phone that is also signed out is redirected exactly once', () => {
  // Both rules match. Without the early return the second branch fires too — two
  // location.replace calls, and on a real page the second can clobber the first's
  // history entry.
  assert.deepEqual(runGate({ width: 393, token: null }), ['index.html']);
});

test('storage that throws is treated as signed out, not crashed on', () => {
  // Safari in private mode used to throw on localStorage access. An uncaught throw
  // here happens BEFORE the body paints, taking the whole page with it.
  const storage = { getItem: () => { throw new Error('SecurityError'); } };
  assert.deepEqual(runGate({ width: 1440, storage }), ['index.html']);
});

test('an empty-string token does not count as a session', () => {
  assert.deepEqual(runGate({ width: 1440, token: '' }), ['index.html']);
});

// ── the desktop, signed-in half ──────────────────────────────────────────────

test('a signed-in desktop visitor is left alone', () => {
  // The half that stops every guard above from passing by redirecting everybody.
  assert.deepEqual(runGate({ width: 1440, token: 'tok-user' }), []);
});

test('the redirect target is relative, so it resolves to the site root', () => {
  // gallery.html is served only at /gallery.html — rewriteHref() leaves the nav link
  // alone on localized pages precisely because the gallery is not in LOCALIZED_PAGES —
  // so `index.html` always resolves to the English home page and there is no locale
  // prefix to preserve. A leading slash would work too; an absolute origin would break
  // every non-production host.
  const [target] = runGate({ width: 393 });
  assert.ok(!/^[a-z]+:/i.test(target), `${target} must not be an absolute URL`);
});

test('the viewport <meta> is parsed before the gate runs', () => {
  // The gate reads the LAYOUT viewport. Above <meta name="viewport"> a phone reports
  // the ~980px desktop fallback, every width check passes, and the redirect silently
  // never fires for anyone — with nothing else failing.
  const html = fs.readFileSync(PAGE, 'utf8');
  const meta = html.search(/<meta\s+name="viewport"/i);
  const gate = html.indexOf('gallery-gate.js');
  assert.notEqual(meta, -1, 'gallery.html has no viewport meta');
  assert.notEqual(gate, -1, 'gallery.html no longer loads the gate');
  assert.ok(meta < gate, 'the viewport meta must come before the gate script in <head>');
});

test('the gate is render-blocking — no defer, async or module', () => {
  // Any of the three defers it past first paint, which would show a frame of the
  // grid (and fire gallery-app.js's fetch of the owner's renders) on the way out.
  const html = fs.readFileSync(PAGE, 'utf8');
  const tag = /<script\b[^>]*gallery-gate\.js[^>]*>/i.exec(html);
  assert.ok(tag, 'no gallery-gate.js script tag');
  assert.ok(
    !/\bdefer\b|\basync\b|type=["']module["']/i.test(tag[0]),
    `${tag[0]} — this one must block the parser; see BLOCKING_ALLOWED in test/frontend/head-scripts.test.js`,
  );
});
