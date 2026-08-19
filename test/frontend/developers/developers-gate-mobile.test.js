// Tier: frontend gate behaviour — public/scripts/developers-gate.js.
//
// The API documentation is a desktop-only page: it is a three-column shell (persistent
// nav, prose, "on this page") and there is no honest way to fold that onto a phone. The
// rule is enforced twice — the footer link is wrapped in `.desktop-only`, and this gate
// turns away anyone who reaches /developers.html anyway. The pairing of those halves and
// the breakpoint they share live in test/frontend/desktop-only-gates.test.js. This file
// owns what only the gate can answer: that the redirect actually fires, at the right
// width, and that it does NOT fire for the desktop reader the page exists for.
//
// UNLIKE gallery-gate.js there is no auth check — the docs are public, and a signed-out
// developer evaluating the API is precisely the audience. A test that this gate leaves a
// visitor with no token alone is therefore a real assertion, not an omission.
//
// The gate is a classic render-blocking IIFE with no exports (a type="module" would be
// deferred past the paint it exists to beat), so it cannot be imported. The SHIPPED
// SOURCE is run here with `window` and `location` passed in as parameters, which shadow
// the globals of the same name inside it — the same technique the sibling gate specs use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = path.join(ROOT, 'public', 'scripts', 'developers-gate.js');
const PAGE = path.join(ROOT, 'public', 'developers.html');

const gateSource = fs.readFileSync(GATE, 'utf8');
const pageHtml = fs.readFileSync(PAGE, 'utf8');

/**
 * The gate with comments stripped, for the "does the CODE do X" assertions below.
 *
 * The file's header explains at length why it carries no localeTarget() and reads no
 * session — so a scan of the raw source finds both names in prose and fails on a file
 * that is behaving exactly as documented. Only executable references can drift.
 */
const gateCode = gateSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * A matchMedia that answers from a width, so the QUERY is under test too: a gate that
 * asked for something other than a max-width (a `pointer:coarse`, which a touchscreen
 * laptop also matches) fails here rather than passing on a stub that says yes to
 * everything.
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
 * Run the real gate.
 * @param {{ width?: number, matchMedia?: any, pathname?: string }} opts
 * @returns {string[]} every URL it tried to replace the page with
 */
function runGate({ width = 1440, matchMedia, pathname = '/developers.html' } = {}) {
  const redirects = [];
  const win = {
    location: { replace: (target) => redirects.push(String(target)) },
    // `undefined` here is the ancient-browser case, not "no match".
    matchMedia: matchMedia === undefined ? matchMediaFor(width) : matchMedia,
  };
  new Function('window', 'location', gateSource)(win, { pathname });
  return redirects;
}

test('a phone-sized viewport is sent to the home page', () => {
  assert.deepEqual(runGate({ width: 393 }), ['index.html']);
});

test('768px is inside the rule and 769px is outside it', () => {
  // The exact boundary, because this is the number that has to agree with the
  // `.desktop-only` rule hiding the footer link. Off by one either way and there is a
  // width where the link is gone but the page loads, or the reverse.
  assert.deepEqual(runGate({ width: 768 }), ['index.html']);
  assert.deepEqual(runGate({ width: 769 }), []);
});

test('a desktop visitor is left alone', () => {
  // The half that stops every assertion above from passing by redirecting everybody.
  assert.deepEqual(runGate({ width: 1440 }), []);
});

test('a signed-out desktop visitor is left alone — the docs are public', () => {
  // Deliberately different from gallery-gate.js, which bounces anyone without a token.
  // Nothing about a session is read here, and this pins that: someone copying the
  // gallery gate wholesale would add an auth check and lock out every evaluator.
  assert.deepEqual(runGate({ width: 1440 }), []);
  assert.ok(!/localStorage|stagifyAuthToken/.test(gateCode),
    'the docs gate must not read a session — the page is public reference material');
});

test('a browser with no matchMedia fails OPEN', () => {
  // Hiding public reference material from someone whose browser cannot be measured is
  // the worse of the two failures.
  assert.deepEqual(runGate({ matchMedia: null }), []);
});

test('a phone is redirected exactly once', () => {
  // One location.replace, not two: a second call can clobber the first's history entry.
  assert.equal(runGate({ width: 393 }).length, 1);
});

test('a localized visitor keeps their language on the way out', () => {
  // developers.html IS in LOCALIZED_PAGES, so /es/developers.html exists. Without
  // localeTarget() a Spanish reader on a phone would be bounced to the ENGLISH root —
  // losing their language at the exact moment we are already taking the page away.
  assert.ok(/localeTarget/.test(gateCode), 'the gate must keep a localized visitor in their locale');
  assert.deepEqual(runGate({ width: 393, pathname: '/es/developers.html' }), ['/es']);
  assert.deepEqual(runGate({ width: 393, pathname: '/ja/developers.html' }), ['/ja']);
  // The unprefixed URL still goes to the plain English home.
  assert.deepEqual(runGate({ width: 393, pathname: '/developers.html' }), ['index.html']);
});

test('the gate is render-blocking and sits BELOW the viewport meta', () => {
  // Both halves of the ordering matter. A `defer`/`type="module"` runs after the paint
  // it exists to beat, so a phone sees a frame of the three-column layout on the way
  // out. And above <meta name="viewport"> the gate reads the ~980px fallback width
  // instead of the layout viewport, so no phone would ever match and the redirect is
  // silently dead.
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(pageHtml);
  assert.ok(head, 'developers.html has no <head>');

  const tag = /<script\s+src="scripts\/developers-gate\.js"[^>]*>/i.exec(head[1]);
  assert.ok(tag, 'developers.html no longer loads the gate in <head>');
  assert.ok(!/\bdefer\b|\basync\b|type="module"/i.test(tag[0]),
    'the gate must stay render-blocking — a deferred gate paints the page it is meant to prevent');

  const viewportAt = head[1].search(/<meta\s+name="viewport"/i);
  assert.ok(viewportAt > -1, 'developers.html has no viewport meta');
  assert.ok(viewportAt < head[1].indexOf(tag[0]),
    'the gate must come AFTER the viewport meta or it measures the desktop fallback width');
});
