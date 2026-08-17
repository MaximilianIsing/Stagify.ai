// Tier: frontend gate behaviour — public/scripts/ai-designer-gate.js's PC-only rule.
//
// The AI Designer is a desktop tool. Two things enforce that, in two different
// files, and they only work as a pair:
//   1. the nav's Staging dropdown hides the AI Designer row below 768px
//      (`desktop-only`, pinned in test/frontend/staging-menu.test.js);
//   2. this gate bounces anyone who reaches /ai-designer.html anyway — a bookmark,
//      a shared link, the guides' prose link, a browser that restored the tab.
//
// Neither is testable by importing the module: the gate is a classic
// render-blocking IIFE with no exports (an ES import would defer it past the paint
// it exists to beat). So this runs the SHIPPED SOURCE with `location`, `window`,
// `document`, `localStorage` and `setTimeout` passed in as parameters, which
// shadow the globals of the same name inside it — the same technique
// test/i18n/locale-data.test.js uses on this file's localeTarget().
//
// What that buys: these are behavioural assertions, not a grep for a string. The
// redirect either happens or it does not, in the real control flow, including the
// part that matters most — the mobile check runs BEFORE the plan check, so a
// paying user on a phone is sent home rather than left on a page hidden by
// `html.ai-gate-pending` waiting for a plan check that will reveal a layout their
// screen cannot use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = path.join(ROOT, 'public', 'scripts', 'ai-designer-gate.js');
const PAGE = path.join(ROOT, 'public', 'ai-designer.html');

const gateSource = fs.readFileSync(GATE, 'utf8');

/**
 * A matchMedia that answers from a width, so a test says "393px phone" rather
 * than "matches: true" — and so the QUERY is under test too: a gate that asked
 * for something other than a max-width (a `pointer:coarse`, say, which a desktop
 * with a touchscreen also matches) fails here instead of passing on a stub that
 * says yes to everything.
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
 * Run the real gate.
 *
 * @param {{ width?: number, pathname?: string, token?: string|null, matchMedia?: any }} opts
 * @returns {{ redirects: string[], html: { className: string }, timers: number[] }}
 */
function runGate({ width = 1440, pathname = '/ai-designer.html', token = null, plan = null, matchMedia } = {}) {
  const redirects = [];
  const timers = [];
  const html = {
    className: '',
    classList: {
      contains: (c) => html.className.split(' ').includes(c),
      remove: (c) => {
        html.className = html.className.split(/\s+/).filter(Boolean).filter((x) => x !== c).join(' ');
      },
    },
  };

  const win = {
    location: { replace: (target) => redirects.push(String(target)) },
    // `undefined` here is the ancient-browser case, not "no match".
    matchMedia: matchMedia === undefined ? matchMediaFor(width) : matchMedia,
  };
  const doc = { documentElement: html };
  // KEYED, not a single value. This used to answer every read with `token`, which was fine
  // while the gate only ever asked whether a token existed. It now also reads
  // `stagifyPlan`, and a stub that hands back 'tok-pro' for both would report the plan as
  // 'tok-pro' — never equal to 'pro', so the pre-paint branch could not be reached at all
  // and three tests would have been asserting the absence of a feature.
  const store = { stagifyAuthToken: token, stagifyPlan: plan };
  const storage = { getItem: (k) => (k in store ? store[k] : null) };
  const timers2 = [];
  const timeout = (fn, ms) => { timers.push(ms); timers2.push(fn); return timers.length; };

  const run = new Function('window', 'document', 'location', 'localStorage', 'setTimeout', gateSource);
  run(win, doc, { pathname }, storage, timeout);
  return { redirects, html, timers, fire: () => timers2.forEach((fn) => fn()) };
}

// ── the PC-only rule ─────────────────────────────────────────────────────────

test('a phone-sized viewport is sent to the home page', () => {
  const { redirects } = runGate({ width: 393, token: 'tok-pro' });
  assert.deepEqual(redirects, ['index.html'], 'a phone goes home, not to the studio');
});

test('the mobile bounce beats the plan gate — a paying user is never left on a hidden page', () => {
  // The failure this pins is silent and specific: check the plan first and a Pro
  // user on a phone gets `ai-gate-pending` (body visibility:hidden) plus a six-second
  // timer, then either a blank-looking page or a bounce with no explanation. The
  // width decision has to come first, before ANY of that is set up.
  const { redirects, html, timers } = runGate({ width: 393, token: 'tok-pro' });
  assert.deepEqual(redirects, ['index.html']);
  assert.equal(html.className, '', 'the page must not be hidden pending a plan check');
  assert.deepEqual(timers, [], 'and no fallback timer should be armed');
});

test('a signed-out phone visitor goes home too, not to the homepage demo anchor', () => {
  // Signed out, the desktop path lands on #ai-designer-demo. On a phone the
  // width check must win outright — otherwise the order of the two branches
  // decides the destination, which is exactly the drift this pins.
  const { redirects } = runGate({ width: 393, token: null });
  assert.deepEqual(redirects, ['index.html']);
});

test('a phone on a localized URL stays in its language', () => {
  const { redirects } = runGate({ width: 393, pathname: '/fr/ai-designer.html', token: 'tok-pro' });
  assert.deepEqual(redirects, ['/fr'], 'a French visitor must not be dropped on the English root');
});

test('768px is inside the rule and 769px is outside it', () => {
  assert.deepEqual(runGate({ width: 768, token: 'tok-pro' }).redirects, ['index.html']);
  assert.deepEqual(runGate({ width: 769, token: 'tok-pro' }).redirects, []);
});

// ── the desktop half, so the guard above cannot pass by redirecting everyone ──

test('a desktop visitor with a cached Stagify+ plan gets the studio pre-painted', () => {
  // The class RESHAPES now; it used to HIDE. `ai-gate-pending` put
  // `body{visibility:hidden}` over the whole page until the plan check answered, and
  // redirected if it never did. `ai-pro-pending` hides only the pitch, which is why the
  // timer below can simply drop it instead of bouncing anyone.
  const g = runGate({ width: 1440, token: 'tok', plan: 'pro' });
  assert.deepEqual(g.redirects, [], 'no redirect for a desktop visitor');
  assert.ok(g.html.className.includes('ai-pro-pending'), 'the subscriber must never see the pitch');
  assert.deepEqual(g.timers, [6000], 'and the stall-safety timer is armed');

  g.fire();
  assert.ok(!g.html.className.includes('ai-pro-pending'), 'a stalled check restores the public page');
  assert.deepEqual(g.redirects, [], 'and still does not bounce anyone');
});

test('a desktop signed-out visitor STAYS — this page has a public view now', () => {
  // The regression this replaces: the gate used to `location.replace` anyone without a
  // token to index.html#ai-designer-demo, so the page written to explain the tool was
  // never shown to the people it was written for, and Googlebot (which carries no token
  // either) was bounced with them. Asserted as a negative, so it is paired below with the
  // positive that the desktop pre-paint still works — "no redirect" passes just as
  // happily on a gate that has stopped doing anything at all.
  const g = runGate({ width: 1440, token: null });
  assert.deepEqual(g.redirects, [], 'a signed-out desktop visitor gets the pitch, not the homepage');
  assert.deepEqual(g.timers, [], 'nothing armed, so nothing to unwind');
  g.fire();
  assert.deepEqual(g.redirects, [], 'and no timer bounces them a moment later either');
});

test('a signed-in FREE desktop visitor stays too, and gets no pre-paint', () => {
  // The shipped markup is already their page; arming the class would hide the pitch on a
  // page whose tool they cannot use.
  const g = runGate({ width: 1440, token: 'tok', plan: 'free' });
  assert.deepEqual(g.redirects, []);
  assert.equal(g.html.className, '');
});

test('a browser with no matchMedia fails OPEN', () => {
  // Locking a paying desktop user out of a tool because their browser cannot be measured
  // is the worse failure. The plan gate on the chat routes still applies.
  const { redirects, html } = runGate({ matchMedia: null, token: 'tok', plan: 'pro' });
  assert.deepEqual(redirects, []);
  assert.ok(html.className.includes('ai-pro-pending'));
});

// ── the couplings that live in other files ───────────────────────────────────
//
// The breakpoint drift guard (this gate's 768px vs `.desktop-only`'s in styles.css)
// is NOT here: it is one rule shared by every desktop-only gate, and lives in
// test/frontend/desktop-only-gates.test.js so a third gate is covered the day it
// is written rather than needing a copy of it.

test('the viewport <meta> is parsed before the gate runs', () => {
  // The gate reads the LAYOUT viewport. Above <meta name="viewport"> a phone
  // reports the ~980px desktop fallback, every width check passes, and the
  // redirect silently never fires for anyone — with nothing else failing.
  const html = fs.readFileSync(PAGE, 'utf8');
  const meta = html.search(/<meta\s+name="viewport"/i);
  const gate = html.indexOf('ai-designer-gate.js');
  assert.notEqual(meta, -1, 'ai-designer.html has no viewport meta');
  assert.notEqual(gate, -1, 'ai-designer.html no longer loads the gate');
  assert.ok(meta < gate, 'the viewport meta must come before the gate script in <head>');
});
