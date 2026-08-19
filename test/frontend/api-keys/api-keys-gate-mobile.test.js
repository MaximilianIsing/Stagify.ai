// Tier: frontend gate behaviour — public/scripts/api-keys-gate.js.
//
// The API dashboard is a desktop page. The rule is enforced twice: the account menu's
// row is `desktop-only` (a width, in CSS) and this gate turns away anyone who reaches
// /api-keys.html anyway. The pairing of those halves, and the breakpoint they share,
// live in test/frontend/desktop-only-gates.test.js. This file owns what only the gate
// can answer — that the redirect fires, where it sends people, and the two things about
// it that are easy to break silently.
//
// WHAT MAKES THIS GATE DIFFERENT FROM gallery-gate.js: it does NOT check for a session.
// The dashboard has a real signed-out state that explains what an API key is, and the
// docs link straight at it, so bouncing a signed-out desktop visitor would send someone
// who followed that link back to the home page. The test below pins that, because
// "copy the gallery gate" is the obvious way to change this file and it would be wrong.
//
// The gate is a classic render-blocking IIFE with no exports (a type="module" would be
// deferred past the paint it exists to beat), so it cannot be imported. The SHIPPED
// SOURCE is run here with `window` passed in as a parameter, which shadows the global
// of the same name inside it — the same technique gallery-gate-mobile.test.js uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = path.join(ROOT, 'public', 'scripts', 'api-keys-gate.js');
const PAGE = path.join(ROOT, 'public', 'api-keys.html');

const gateSource = fs.readFileSync(GATE, 'utf8');

/**
 * A matchMedia that answers from a width, so the QUERY is under test too: a gate that
 * asked for something other than a max-width (a `pointer:coarse`, which a touchscreen
 * laptop also matches) fails here rather than passing on a stub that says yes to
 * everything.
 * @param {number} width - The viewport to answer for.
 * @returns {(q: string) => { matches: boolean }} A matchMedia stub.
 */
function matchMediaFor(width) {
  return (query) => {
    const m = /\(\s*max-width:\s*(\d+)px\s*\)/.exec(query);
    assert.ok(m, `the gate asked a media query this stub cannot answer: ${query}`);
    return { matches: width <= Number(m[1]) };
  };
}

/**
 * Run the real gate.
 * @param {{ width?: number, matchMedia?: any }} [opts] - Viewport, or a broken matchMedia.
 * @returns {string[]} Every URL it tried to replace the page with.
 */
function runGate({ width = 1440, matchMedia } = {}) {
  const redirects = [];
  const win = {
    location: { replace: (target) => redirects.push(String(target)) },
    // `undefined` here is the ancient-browser case, not "no match".
    matchMedia: matchMedia === undefined ? matchMediaFor(width) : matchMedia,
  };
  new Function('window', 'location', 'localStorage', gateSource)(
    win,
    { pathname: '/api-keys.html' },
    { getItem: () => null },
  );
  return redirects;
}

test('a phone-sized viewport is sent to the home page', () => {
  assert.deepEqual(runGate({ width: 393 }), ['index.html']);
});

test('768px is inside the rule and 769px is outside it', () => {
  assert.deepEqual(runGate({ width: 768 }), ['index.html']);
  assert.deepEqual(runGate({ width: 769 }), []);
});

test('a desktop visitor is left alone', () => {
  // The half that stops every guard above from passing by redirecting everybody.
  assert.deepEqual(runGate({ width: 1440 }), []);
});

test('a browser with no matchMedia fails OPEN', () => {
  // A cramped dashboard for someone we cannot measure beats bouncing a desktop visitor
  // off their own account page.
  assert.deepEqual(runGate({ matchMedia: null }), []);
});

test('a signed-out desktop visitor is NOT redirected', () => {
  // Deliberately unlike gallery-gate.js. The page has a signed-out state that explains
  // the API and offers a way in, and developers.html links straight here — so the one
  // change that would break this page's front door is the obvious one to make by
  // analogy. The stub above hands the gate a localStorage with no token; a session
  // check would turn that into a redirect.
  assert.deepEqual(runGate({ width: 1440 }), []);
});

test('the redirect target is relative, so it resolves to the site root', () => {
  // api-keys.html is served only at /api-keys.html — it is noindex and absent from
  // LOCALIZED_PAGES — so `index.html` always resolves to the English home page and
  // there is no locale prefix to preserve. An absolute origin would break every
  // non-production host.
  const [target] = runGate({ width: 393 });
  assert.ok(!/^[a-z]+:/i.test(target), `${target} must not be an absolute URL`);
});

test('the viewport <meta> is parsed before the gate runs', () => {
  // The gate reads the LAYOUT viewport. Above <meta name="viewport"> a phone reports
  // the ~980px desktop fallback, the width check passes, and the redirect silently
  // never fires for anyone — with nothing else failing.
  const html = fs.readFileSync(PAGE, 'utf8');
  const meta = html.search(/<meta\s+name="viewport"/i);
  const gate = html.indexOf('api-keys-gate.js');
  assert.notEqual(meta, -1, 'api-keys.html has no viewport meta');
  assert.notEqual(gate, -1, 'api-keys.html no longer loads the gate');
  assert.ok(meta < gate, 'the viewport meta must come before the gate script in <head>');
});

test('the gate is render-blocking — no defer, async or module', () => {
  // Any of the three defers it past first paint, which would show a frame of the
  // inspector (and fire its three authenticated fetches) on the way out.
  const html = fs.readFileSync(PAGE, 'utf8');
  const tag = /<script\b[^>]*api-keys-gate\.js[^>]*>/i.exec(html);
  assert.ok(tag, 'no api-keys-gate.js script tag');
  assert.ok(
    !/\bdefer\b|\basync\b|type=["']module["']/i.test(tag[0]),
    `${tag[0]} — this one must block the parser; see BLOCKING_ALLOWED in test/frontend/head-scripts.test.js`,
  );
});
